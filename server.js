// --- REQUIRED MODULES ---
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios'); // Used to make API calls to Meta and Apps Script

const app = express();

// =========================================================================
// !!! CRITICAL CONFIGURATION DETAILS !!!
// =========================================================================

const PORT = process.env.PORT || 5000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
// NOTE: The correct Phone Number ID (805371682666878) must be set for PHONE_NUMBER_ID.
// CRITICAL: Ensure ACCESS_TOKEN is a PERMANENT token in your Render environment.
const ACCESS_TOKEN = process.env.ACCESS_TOKEN; 
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; 

// Gemini API Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 
const GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025';

// --- GOOGLE APPS SCRIPT CONFIGURATION ---
// NOTE: Make sure your Google Sheet has all required headers in Row 1!
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycby8gGXRYTiRjWcPZbu0gcTEb0KPoskQlPKbEnphtvPysZYcnyX4_KcGcXJy6g0h2ndM_g/exec'; 

// --- ENVIRONMENT VARIABLE CHECKS ---
if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("CRITICAL ERROR: WhatsApp environment variables are missing.");
    process.exit(1); 
}

// =========================================================================
// GOOGLE APPS SCRIPT & USER STATE MANAGEMENT 
// =========================================================================

/**
 * Gets the user's current state from Google Sheets by making a POST request
 * to the deployed Google Apps Script Web App.
 * @param {string} phone The user's WhatsApp ID.
 * @returns {Promise<object>} The user document retrieved from the sheet.
 */
async function getUserState(phone) {
    try {
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'GET_STATE',
            phone: phone
        });
        
        if (response.data.success && response.data.user) {
            return response.data.user;
        } else {
            console.error("Apps Script GET_STATE failed:", response.data.error || "Unknown response structure");
            throw new Error("Apps Script returned an unsuccessful response.");
        }

    } catch (e) {
        console.error("Error communicating with Apps Script (GET_STATE):", e.response?.data || e.message);
        return { 
            phone: phone, 
            user_id: `ERROR-${Date.now()}`,
            role: 'unassigned', 
            name: '',
            city: '',
            created_at: new Date().toISOString(),
            status: 'NEW', 
            current_flow: 'onboarding',
            row_index: 0 
        };
    }
}

/**
 * Saves or updates the user profile in Google Sheets.
 * @param {object} user The user object to save. Must contain row_index.
 */
async function saveUser(user) {
    try {
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'SAVE_STATE',
            user: user
        });
        
        if (response.data.success) {
            console.log(`User ${user.phone} state updated via Apps Script. Status: ${user.status}`);
        } else {
            console.error("Apps Script SAVE_STATE failed:", response.data.error || "Unknown response structure");
        }
        
    } catch (e) {
        console.error("Error communicating with Apps Script (SAVE_STATE):", e.response?.data || e.message);
    }
}

// =========================================================================
// GEMINI AI INTEGRATION
// =========================================================================

const SYSTEM_INSTRUCTION = `
You are YourHelpa, a WhatsApp-based conversational marketplace operating exclusively in **Nigeria**, currently serving users in **Lagos State** and **Oyo State**.
Your primary goal is to facilitate simple and safe transactions for both **Services (Hiring)** and **Items (Buying/Selling)**.
Your persona is friendly, encouraging, highly reliable, and concise. You use emojis sparingly for clarity.
Crucially, you are capable of fetching and summarizing seller details, product catalogs, service portfolios, and associated online presence (websites, blogs, social media) from the web to match user requests.

Current Task: Act as the conversational router and flow guide, focusing on the Nigerian context.

Response Rules:
1. Always keep responses short and to the point.
2. All location references must prioritize Lagos or Oyo State.
3. When presenting options, use numbered lists.
`;

// Define the JSON schema for service request parsing
const SERVICE_REQUEST_SCHEMA = {
  type: "OBJECT",
  properties: {
    service_category: { 
        type: "STRING", 
        description: "A single, normalized category for the service or item (e.g., 'Plumber', 'Tailor', 'iPhone 12', 'Custom Cake'). Must be relevant to Nigerian goods/services. Do not use 'Other'." 
    },
    description_summary: { 
        type: "STRING", 
        description: "A very concise summary of the specific job or item requested, max 10 words." 
    },
    extracted_city: { 
        type: "STRING", 
        description: "The city or area mentioned (e.g., 'Ikeja', 'Yaba', 'Ibadan', 'Ogbomosho'). Leave empty if not found." 
    },
    extracted_state: { 
        type: "STRING", 
        description: "The state (Lagos or Oyo) mentioned or inferred from the city. Default to 'Lagos' if no location is mentioned. Only use 'Lagos' or 'Oyo'." 
    },
    extracted_budget: { 
        type: "STRING", 
        description: "The budget, price range, or compensation mentioned, if any (e.g., '₦50,000', '$100'). Leave empty if not found." 
    }
  },
  required: ["service_category", "description_summary"]
};


/**
 * Calls the Gemini API for conversational responses (Text-to-Text).
 */
async function generateAIResponse(text, systemPrompt = SYSTEM_INSTRUCTION) {
    if (!GEMINI_API_KEY) {
        return "⚠️ AI Service Error: GEMINI_API_KEY is not configured.";
    }
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const payload = {
        contents: [{ parts: [{ text: text }] }],
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
    };

    try {
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = response.data;
        return result.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't process that request right now. Please try again.";

    } catch (error) {
        console.error("Gemini Conversational API Error:", error.response?.data || error.message);
        return "I'm having trouble connecting to my brain. Please wait a moment and try sending your message again.";
    }
}

/**
 * Calls the Gemini API for structured output (JSON) with Google Search Grounding.
 */
async function parseServiceRequest(requestText) {
    if (!GEMINI_API_KEY) {
        return null;
    }
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const parsingInstruction = `
        You are a highly efficient text parsing engine focusing on the Nigerian market in Lagos and Oyo States. Analyze the following user request for a service or item purchase.
        Extract the most specific category, a very brief summary, the city/area, the state (Lagos or Oyo), and the budget/price.
        Your entire output MUST be a JSON object adhering to the provided schema.
        User Request: "${requestText}"
    `;

    const payload = {
        contents: [{ parts: [{ text: parsingInstruction }] }],
        tools: [{ "google_search": {} }], // Enable Google Search for contextual grounding
        config: {
            responseMimeType: "application/json",
            responseSchema: SERVICE_REQUEST_SCHEMA,
        },
    };

    try {
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = response.data;
        const jsonString = result.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (jsonString) {
            return JSON.parse(jsonString);
        }
        return null;

    } catch (error) {
        console.error("Gemini Structured Parsing API Error:", error.response?.data || error.message);
        return null;
    }
}

// =========================================================================
// WHATSAPP HELPER FUNCTIONS
// =========================================================================

const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

/**
 * Returns the Main Menu structure based on the user's role.
 */
function getMainMenu(role) {
    let options = [];
    if (role === 'hire' || role === 'unassigned') {
        options.push("1️⃣ Find a professional or service provider (Hire)");
    }
    if (role === 'hire' || role === 'unassigned') {
        options.push("2️⃣ Buy an item (Buyer)");
    }
    if (role === 'helpa' || role === 'unassigned') {
        options.push("3️⃣ Register as a Helpa (Offer Service)");
    }
    if (role === 'seller' || role === 'unassigned') {
        options.push("4️⃣ List items for sale (Seller)");
    }

    options.push("5️⃣ My Active Jobs or Purchases");
    options.push("6️⃣ Support");

    let menu = `🇳🇬 *Welcome to YourHelpa!* We connect you to verified services and sellers in *Lagos* and *Oyo State*. How can I help you today? Please reply with the number of your choice:\n\n`;
    menu += options.join('\n');
    
    return menu;
}


async function sendMessage(to, text) {
    try {
        await axios.post(META_API_URL, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: to,
            type: "text",
            text: {
                body: text
            }
        }, {
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[Response Sent] To: ${to} | Text: ${text.substring(0, 50)}...`);
    } catch (error) {
        console.error("Error sending message:", error.response?.data || error.message);
    }
}

// =========================================================================
// MATCHING LOGIC (New Feature)
// =========================================================================

/**
 * Handles the AI-powered matching process for services or items.
 * Uses Gemini with Google Search grounding to simulate real-world data fetching.
 */
async function handleMatching(user, senderId) {
    const isService = user.current_flow === 'service_request';
    const flowType = isService ? 'Service Request (Hiring)' : 'Item Purchase (Buying)';
    const category = isService ? user.service_category : user.item_name;
    const summary = isService ? user.description_summary : user.item_description;
    const providerRole = isService ? 'Helpa (Service Provider)' : 'Seller (Product Vendor)';
    const profileLinkType = isService ? 'Service Portfolio' : 'Product Catalog';
    
    const matchingPrompt = `
        You are a Nigerian Market Intelligence Engine for YourHelpa. The user needs help with a ${flowType}.
        
        Goal: Find 3 top-rated, *mock* ${providerRole}s in Nigeria that match the user's request, focusing on Lagos and Oyo states.
        
        User Request:
        - Category: ${category}
        - Summary: "${summary}"
        - Location: ${user.city_initial || 'Anywhere'}, ${user.state_initial} State
        - Budget: ${user.budget_initial || 'Flexible'}

        Task:
        1. Use Google Search grounding to simulate finding relevant Nigerian market businesses, popular services, and product examples within the Lagos/Oyo area.
        2. Generate a response that lists exactly *three* potential ${providerRole} matches.
        3. For each match, provide:
           - A Nigerian-sounding **Name** (e.g., 'Ayo's Auto Services').
           - A 1-sentence **Description** of their portfolio and reputation (e.g., 'Highly rated for swift car repair in Ibadan, specializing in Honda models.').
           - A **Mock Portfolio Link** (This is crucial: simulate a web link, blog, or WhatsApp Business link, e.g., 'Web: https://ayoautos.ng' or 'WhatsApp: +23480-123-4567').
           
        Format the output clearly using asterisks for emphasis and numbered lists. Do NOT include any introductory or concluding sentences outside the list itself.
    `;

    // Use Gemini with Search Grounding
    const searchResults = await generateAIResponse(matchingPrompt, SYSTEM_INSTRUCTION);
    
    let reply = `🇳🇬 *Search Complete!* Based on your need for a *${category}* in *${user.city_initial || user.state_initial}* for ${user.budget_initial || 'a flexible price'}, here are 3 verified ${providerRole}s that match your request:\n\n`;
    
    reply += searchResults;
    
    reply += `\n\nTo view their full ${profileLinkType}s, click the links above. Which Helpa/Seller (1, 2, or 3) would you like to connect with for this job/purchase?`;

    user.status = isService ? 'SERVICE_AWAIT_SELECTION' : 'BUYER_AWAIT_SELECTION';
    await saveUser(user);
    await sendMessage(senderId, reply);
}

// =========================================================================
// MESSAGE ROUTER AND FLOW LOGIC (The core of the bot)
// =========================================================================

/**
 * Utility function to save updated details from parsed data back to the user object.
 */
function updateUserDetails(user, parsedData) {
    user.service_category = parsedData.service_category;
    user.description_summary = parsedData.description_summary;
    user.city_initial = parsedData.extracted_city;

    // Ensure state is one of the target states or default to Lagos
    let extractedState = parsedData.extracted_state.toLowerCase();
    if (extractedState.includes('oyo')) {
        user.state_initial = 'Oyo';
    } else {
        user.state_initial = 'Lagos'; // Default
    }
    user.budget_initial = parsedData.extracted_budget;
    return user;
}

/**
 * Builds the confirmation message for the user based on their current saved state.
 */
function buildConfirmationMessage(user, type = 'service') {
    const category = type === 'service' ? user.service_category : user.item_name;
    const summary = type === 'service' ? user.description_summary : user.item_description;
    const budgetDisplay = user.budget_initial || "₦XXXX";

    let message = `*Got it!* You're looking for a *${category}* to help with: _"${summary}"_.\n\n`;

    message += `I see this job/purchase is in *${user.state_initial} State*. `;

    if (user.city_initial) {
        message += `(Specifically the ${user.city_initial} area). `;
    }

    message += `Is this correct, and is your estimated budget/price around *${budgetDisplay}*?\n\n`;
    message += `Reply with *YES* to confirm these details, or send the correct budget/city/state to adjust.`;
    return message;
}

/**
 * Main function to handle the user's message and determine the next step.
 */
async function handleMessageFlow(senderId, senderName, incomingText) {
    try {
        let user = await getUserState(senderId);
        let replyText = '';
        const lowerText = incomingText.trim().toLowerCase();

        // --- NEW USER ONBOARDING ---
        if (user.status === 'NEW' || user.status === 'unassigned' || user.status === 'ERROR') {
            const onboardingPrompt = `
            Hello ${senderName}, I'm YourHelpa, your Nigerian marketplace assistant!
            
            To get started in Lagos or Oyo State, please tell me your primary goal by replying with the number of your choice:

            1️⃣ HIRE someone (find a professional or service)
            2️⃣ OFFER a service (become a Helpa)
            3️⃣ SELL items (list products for sale)
            `;
            user.status = 'ONBOARDING_ROLE_ASKED';
            await saveUser(user);
            replyText = onboardingPrompt;
        
        } 
        
        // --- PROCESSING ONBOARDING ROLE SELECTION ---
        else if (user.status === 'ONBOARDING_ROLE_ASKED') {
            const choice = lowerText;
            let newRole = '';

            if (choice.includes('1') || choice.includes('hire')) {
                newRole = 'hire';
            } else if (choice.includes('2') || choice.includes('offer')) {
                newRole = 'helpa';
            } else if (choice.includes('3') || choice.includes('sell')) {
                newRole = 'seller';
            } else {
                replyText = "I didn't quite catch that. Please reply with *1*, *2*, or *3* to select your primary goal.";
                await sendMessage(senderId, replyText);
                return;
            }

            user.role = newRole;
            user.status = 'MAIN_MENU';
            await saveUser(user);

            const aiPrompt = `The user selected the role: ${newRole}. Generate a single, concise, and friendly welcome message (max 3 sentences) that confirms their choice, emphasizes the Lagos/Oyo focus, and encourages them to proceed.`;
            const welcomeMessage = await generateAIResponse(aiPrompt);
            
            await sendMessage(senderId, welcomeMessage);
            replyText = getMainMenu(user.role);

        } 
        
        // --- FLOW 1: SERVICE REQUEST: ASK WHAT ---
        else if (user.status === 'SERVICE_ASK_WHAT') {
            
            const parsedData = await parseServiceRequest(incomingText);

            if (!parsedData) {
                replyText = "I had trouble understanding that. Could you please describe the service you need again? E.g., 'Need a competent tailor in Ibadan to make an outfit for ₦15,000.'";
            } else {
                user = updateUserDetails(user, parsedData);
                user.status = 'SERVICE_CONFIRM_DETAILS'; 
                await saveUser(user);
                replyText = buildConfirmationMessage(user, 'service');
            }
        } 
        
        // --- FLOW 1: SERVICE REQUEST: CONFIRM DETAILS ---
        else if (user.status === 'SERVICE_CONFIRM_DETAILS') {
            if (lowerText.includes('yes') || lowerText.includes('yup') || lowerText.includes('correct')) {
                // CONFIRMED: Move to the matching phase
                user.status = 'SERVICE_MATCHING';
                await saveUser(user);
                // Send a quick acknowledgment before starting the long search process
                await sendMessage(senderId, await generateAIResponse(`The user confirmed the request. Give a very quick, excited response (max 2 sentences) and tell them you are now searching for the top 3 verified professionals (Helpas) that match these criteria in Lagos/Oyo.`));
                
                // CRITICAL: Call the matching function
                await handleMatching(user, senderId);
                return; // Exit after handleMatching which sends the final reply

            } else {
                // CORRECTION: Re-parse the input to update the details
                const parsedData = await parseServiceRequest(incomingText);

                if (!parsedData) {
                    replyText = "Sorry, I still didn't get a clear correction. Please confirm with *YES* or send a clear correction (e.g., 'Change the budget to ₦20,000' or 'It's in Lekki, Lagos').";
                } else {
                    user = updateUserDetails(user, parsedData);
                    // Stay in this state, and re-ask for confirmation with the new data
                    await saveUser(user); 
                    replyText = buildConfirmationMessage(user, 'service');
                }
            }
        }
        
        // --- FLOW 2: ITEM PURCHASE: ASK WHAT ---
        else if (user.status === 'BUYER_ASK_ITEM') {
            
            const parsedData = await parseServiceRequest(incomingText);

            if (!parsedData) {
                replyText = "I need a better description of the item. What exactly are you looking for? E.g., 'A used iPhone 12 Pro Max in good condition in Ibadan, budget ₦350,000'.";
            } else {
                
                // Save the parsed data for the item
                user.item_name = parsedData.service_category; 
                user.item_description = parsedData.description_summary;
                
                user = updateUserDetails(user, parsedData); // Uses the utility to handle location/budget

                user.status = 'BUYER_CONFIRM_DETAILS';
                await saveUser(user);
                replyText = buildConfirmationMessage(user, 'item');
            }
        }

        // --- FLOW 2: ITEM PURCHASE: CONFIRM DETAILS ---
        else if (user.status === 'BUYER_CONFIRM_DETAILS') {
            if (lowerText.includes('yes') || lowerText.includes('yup') || lowerText.includes('correct')) {
                // CONFIRMED: Move to the matching phase
                user.status = 'BUYER_MATCHING';
                await saveUser(user);
                // Send a quick acknowledgement before starting the long search process
                await sendMessage(senderId, await generateAIResponse(`The user confirmed the item request. Give a very quick, excited response (max 2 sentences) and tell them you are now searching for the top 3 verified sellers that match these criteria in Lagos/Oyo.`));
                
                // CRITICAL: Call the matching function
                await handleMatching(user, senderId);
                return; // Exit after handleMatching which sends the final reply

            } else {
                // CORRECTION: Re-parse the input to update the details
                const parsedData = await parseServiceRequest(incomingText);

                if (!parsedData) {
                    replyText = "Sorry, I still didn't get a clear correction. Please confirm with *YES* or send a clear correction (e.g., 'Change the price to ₦300,000' or 'It should be a brand new item').";
                } else {
                    // Update the user details with the re-parsed data
                    user.item_name = parsedData.service_category; 
                    user.item_description = parsedData.description_summary;
                    
                    user = updateUserDetails(user, parsedData); // Uses utility

                    // Stay in this state, and re-ask for confirmation with the new data
                    await saveUser(user); 
                    replyText = buildConfirmationMessage(user, 'item');
                }
            }
        }
        
        // --- FLOW 1 & 2: AWAITING SELECTION ---
        else if (user.status === 'SERVICE_AWAIT_SELECTION' || user.status === 'BUYER_AWAIT_SELECTION') {
            const selection = parseInt(lowerText.match(/\d+/)?.[0]); // Extract the number
            
            if (selection >= 1 && selection <= 3) {
                const type = user.current_flow === 'service_request' ? 'Helpa' : 'Seller';
                user.status = 'MAIN_MENU'; // Move back to main menu
                await saveUser(user);
                
                replyText = await generateAIResponse(`The user selected option ${selection} to connect with a ${type}. Generate a single, friendly sentence (max 2 sentences) that confirms the selection and instructs the user to *wait for a direct message* from the selected ${type} to finalize the transaction.`);

            } else {
                 replyText = "Please select the number (1, 2, or 3) of the Helpa/Seller you wish to connect with, or type *MENU* to start over.";
            }
        }

        // --- MAIN MENU ROUTER ---
        else if (user.status === 'MAIN_MENU' || user.status === 'AWAITING_FLOW_START') {
            
            // Simple command handling
            if (lowerText === 'menu' || lowerText === 'hi' || lowerText === 'hello') {
                 replyText = getMainMenu(user.role);
                 await sendMessage(senderId, replyText);
                 return;
            }

            // Route the user based on the selected number
            switch (lowerText) {
                case '1':
                    // Service Request Flow (Hiring Someone)
                    user.current_flow = 'service_request';
                    user.status = 'SERVICE_ASK_WHAT';
                    await saveUser(user);
                    replyText = await generateAIResponse("The user is starting the 'Find a professional or service provider' flow. Ask them 'What service do you need, and where? (e.g., A plumber in Ibadan, a graphic designer in Lagos)' in a friendly, conversational tone.");
                    break;
                case '2':
                    // Buyer Flow (Purchasing Items)
                    user.current_flow = 'buyer_flow';
                    user.status = 'BUYER_ASK_ITEM';
                    await saveUser(user);
                    replyText = await generateAIResponse("The user is starting the 'Buy an item' flow. Ask them 'What item are you looking to buy, and where? (e.g., A used iPhone 12 in Lagos or a custom cake in Ibadan)' in a friendly, conversational tone.");
                    break;
                case '3':
                    // Section 5: Helpa Registration
                    user.current_flow = 'helpa_registration';
                    user.status = 'HELPA_ASK_NAME';
                    await saveUser(user);
                    replyText = await generateAIResponse("The user is starting the 'Helpa Registration' flow for Lagos/Oyo. Ask them for their full name and city to begin registration.");
                    break;
                case '4':
                    // Section 6: Seller Registration
                    user.current_flow = 'seller_registration';
                    user.status = 'SELLER_ASK_PRODUCT';
                    await saveUser(user);
                    replyText = await generateAIResponse("The user is starting the 'Seller Registration' flow. Ask them for the name and a short description of the first item they want to list for sale in Lagos/Oyo.");
                    break;
                case '5':
                    replyText = "The *My Active Jobs* feature is under construction! Check back soon.";
                    break;
                case '6':
                    replyText = await generateAIResponse("The user needs support. Acknowledge this and offer a way to contact a human admin using a mock email address: support@yourhelpa.com.");
                    break;
                default:
                    replyText = await generateAIResponse(`The user sent: "${incomingText}". They are at the Main Menu. They need to be guided back to choosing a numbered option from the menu.`);
                    break;
            }
        } 
        
        // --- DEFAULT FALLBACK ---
        else {
            replyText = getMainMenu(user.role);
            user.status = 'MAIN_MENU';
            await saveUser(user);
        }
        
        // Send the final generated response
        if (replyText) {
             await sendMessage(senderId, replyText);
        }

    } catch (error) {
        console.error("Critical error in handleMessageFlow:", error.message);
        await sendMessage(senderId, "A critical system error occurred while processing your request. Please try again later.");
    }
}


// =========================================================================
// EXPRESS SERVER SETUP
// =========================================================================

app.use(bodyParser.json());

// --- 1. WEBHOOK VERIFICATION (GET request) ---
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WEBHOOK VERIFIED successfully!');
        res.status(200).send(challenge);
    } else {
        console.error('Webhook verification failed!');
        res.sendStatus(403);
    }
});

// --- 2. MESSAGE HANDLING (POST request) ---
app.post('/webhook', (req, res) => {
    const data = req.body;

    if (data.object === 'whatsapp_business_account') {
        data.entry.forEach(entry => {
            entry.changes.forEach(change => {
                if (change.field === 'messages' && change.value.messages) {
                    const message = change.value.messages[0];
                    const senderId = change.value.contacts[0].wa_id;
                    const senderName = change.value.contacts[0].profile.name;
                    const incomingText = message.text?.body || '';

                    console.log(`\n--- YourHelpa: NEW MESSAGE RECEIVED ---`);
                    console.log(`From: ${senderName} (${senderId})`);
                    console.log(`Text: ${incomingText}`);

                    // ASYNC Call to the main logic flow
                    handleMessageFlow(senderId, senderName, incomingText);
                }
            });
        });
    }
    // ALWAYS respond with a 200 OK to Meta
    res.sendStatus(200);
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`\nYourHelpa Server is listening on port ${PORT}`);
    console.log(`Webhook URL: https://yourhelpa-chatbot.onrender.com/webhook`);
    console.log("✅ State management delegated to Google Apps Script.");
});