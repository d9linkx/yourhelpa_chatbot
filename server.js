// --- REQUIRED MODULES ---
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();

// =========================================================================
// !!! CRITICAL CONFIGURATION DETAILS !!!
// =========================================================================

const PORT = process.env.PORT || 5000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN; 
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; 

// Gemini API Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 
const GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025';

// --- GOOGLE APPS SCRIPT CONFIGURATION (UPDATED URL) ---
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyayObttIKkjMFsem9SHGfSSft6-MTmI8rKRYyudCmaC_kPLTlLnRTdBw0TU_5RFShitA/exec'; 

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("CRITICAL ERROR: WhatsApp environment variables are missing.");
    process.exit(1); 
}

// =========================================================================
// GOOGLE APPS SCRIPT & USER STATE MANAGEMENT
// =========================================================================

/**
 * Gets the user's current state from Google Sheets.
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
        // Default user object for new/error state
        return { 
            phone: phone, 
            user_id: `ERROR-${Date.now()}`,
            role: 'unassigned', 
            name: '',
            city: '',
            created_at: new Date().toISOString(),
            status: 'NEW', 
            current_flow: 'onboarding',
            row_index: 0,
            service_category: '', 
            description_summary: '', 
            city_initial: '', 
            state_initial: 'Lagos', 
            budget_initial: '', 
            item_name: '', 
            item_description: ''
        };
    }
}

/**
 * Saves or updates the user profile in Google Sheets.
 * @param {object} user The user object to save.
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
// GEMINI AI INTEGRATION (Updated for Intent Detection and Structured Matching)
// =========================================================================

const SYSTEM_INSTRUCTION = `
You are YourHelpa, a WhatsApp-based conversational marketplace operating exclusively in **Nigeria**, currently serving users in **Lagos State** and **Oyo State**.
Your primary goal is to facilitate simple and safe transactions for both **Services (Hiring)** and **Items (Buying/Selling)**.
Your persona is friendly, encouraging, highly reliable, and concise. You use emojis sparingly for clarity.
Crucially, you are capable of fetching and summarizing seller details, product catalogs, service portfolios, and associated online presence (websites, blogs, social media) from the web to match user requests.

Response Rules:
1. Always keep responses short and to the point.
2. All location references must prioritize Lagos or Oyo State.
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

// Define the schema for Intent Detection
const INTENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: { 
        type: "STRING", 
        description: "The most relevant action ID the user is asking for. Must be one of: OPT_FIND_SERVICE, OPT_BUY_ITEM, OPT_REGISTER_HELPA, OPT_LIST_ITEM, OPT_MY_ACTIVE, OPT_SUPPORT, MENU, UNKNOWN." 
    }
  },
  required: ["intent"]
};

/**
 * Uses Gemini to detect the user's intent from their text input.
 * @param {string} input The user's typed text or interactive button/list ID.
 * @param {string} role The user's current role ('hire', 'helpa', 'seller').
 * @returns {Promise<string>} The standardized intent ID (e.g., 'OPT_FIND_SERVICE').
 */
async function getAIIntent(input, role) {
    if (!GEMINI_API_KEY) return 'UNKNOWN';
    
    // Check for explicit IDs/Keywords first to save an API call
    if (input.startsWith('OPT_') || input.startsWith('CONFIRM_') || input.startsWith('CORRECT_') || input.startsWith('SELECT_')) return input;
    if (input === 'MENU' || input === 'hi' || input === 'hello' || input === 'back') return 'MENU';
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const parsingInstruction = `
        The user has sent the following message: "${input}". 
        The user's current role is "${role}".
        Determine the user's intent from the following allowed options:
        - OPT_FIND_SERVICE (for hiring/finding a professional/service)
        - OPT_BUY_ITEM (for buying a product/item)
        - OPT_REGISTER_HELPA (for offering a service)
        - OPT_LIST_ITEM (for listing an item for sale)
        - OPT_MY_ACTIVE (for checking active jobs/purchases)
        - OPT_SUPPORT (for seeking support or updating a profile)
        - MENU (for returning to the main menu)
        - UNKNOWN (if none of the above apply)
        
        Your entire output MUST be a JSON object adhering to the provided schema.
    `;

    const payload = {
        contents: [{ parts: [{ text: parsingInstruction }] }],
        config: {
            responseMimeType: "application/json",
            responseSchema: INTENT_SCHEMA,
        },
    };

    try {
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        
        const jsonString = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
        const parsed = JSON.parse(jsonString);
        return parsed.intent || 'UNKNOWN';

    } catch (error) {
        console.error("Gemini Intent Detection API Error:", error.response?.data || error.message);
        return 'UNKNOWN'; // Default to unknown if API fails
    }
}

/**
 * Calls the Gemini API for conversational responses (Text-to-Text).
 */
async function generateAIResponse(text, systemPrompt = SYSTEM_INSTRUCTION) {
    if (!GEMINI_API_KEY) return "⚠️ AI Service Error: GEMINI_API_KEY is not configured.";
    
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
 * Calls the Gemini API for structured output (JSON) with Google Search Grounding for parsing requests.
 */
async function parseServiceRequest(requestText) {
    if (!GEMINI_API_KEY) return null;
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const parsingInstruction = `
        You are a highly efficient text parsing engine focusing on the Nigerian market in Lagos and Oyo States. Analyze the following user request for a service or item purchase.
        Extract the most specific category, a very brief summary, the city/area, the state (Lagos or Oyo), and the budget/price.
        Your entire output MUST be a JSON object adhering to the provided schema.
        User Request: "${requestText}"
    `;

    const payload = {
        contents: [{ parts: [{ text: parsingInstruction }] }],
        tools: [{ "google_search": {} }], 
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
// WHATSAPP INTERACTIVE MESSAGING FUNCTIONS
// =========================================================================

const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

/**
 * Sends a WhatsApp message (text, interactive list, or buttons).
 */
async function sendWhatsAppMessage(to, messagePayload) {
    try {
        const finalPayload = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: to,
            ...messagePayload
        };

        await axios.post(META_API_URL, finalPayload, {
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        const type = messagePayload.type || 'text';
        console.log(`[Response Sent] To: ${to} | Type: ${type}`);
    } catch (error) {
        console.error("Error sending message:", error.response?.data || error.message);
    }
}

/**
 * Generates the Main Menu as a WhatsApp Interactive List Message.
 */
function getMainMenu(role, senderName) {
    const welcomeText = `🇳🇬 Welcome back, ${senderName}! We connect you to verified services and sellers in *Lagos* and *Oyo State*. How can I help you today? You can also just type what you need!`;
    
    const hireBuySection = {
        title: "Find or Buy (Requester)",
        rows: []
    };
    hireBuySection.rows.push({ id: "OPT_FIND_SERVICE", title: "1️⃣ Find a professional (Hire Service)" });
    hireBuySection.rows.push({ id: "OPT_BUY_ITEM", title: "2️⃣ Buy an item (Purchase Product)" });

    const offerSellSection = {
        title: "Offer or Sell (Provider/Seller)",
        rows: []
    };
    if (role !== 'helpa') { // Only show registration if not already a Helpa
        offerSellSection.rows.push({ id: "OPT_REGISTER_HELPA", title: "3️⃣ Register as a Helpa (Offer Service)" });
    }
    if (role !== 'seller') { // Only show listing if not already a Seller
        offerSellSection.rows.push({ id: "OPT_LIST_ITEM", title: "4️⃣ List items for sale (Seller)" });
    }

    const accountSection = {
        title: "Account & Support",
        rows: [
            { id: "OPT_MY_ACTIVE", title: "5️⃣ My Active Jobs/Purchases" },
            { id: "OPT_SUPPORT", title: "6️⃣ Support / Update Profile" }
        ]
    };

    const sections = [hireBuySection, offerSellSection, accountSection].filter(sec => sec.rows.length > 0 && sec.rows.length <= 10);
    
    return {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: "YourHelpa Main Menu" },
            body: { text: welcomeText },
            action: {
                button: "View All Options",
                sections: sections
            }
        }
    };
}

/**
 * Generates a WhatsApp Interactive Button Message for YES/NO confirmation.
 */
function getConfirmationButtons(bodyText, yesId, noId) {
    return {
        type: "interactive",
        interactive: {
            type: "button",
            body: { text: bodyText },
            action: {
                buttons: [
                    { type: "reply", reply: { id: yesId, title: "✅ YES, Confirm" } },
                    { type: "reply", reply: { id: noId, title: "❌ NO, Correct" } }
                ]
            }
        }
    };
}

/**
 * Fallback to sending a simple text message.
 */
function sendTextMessage(to, text) {
    return sendWhatsAppMessage(to, { type: "text", text: { body: text } });
}


// =========================================================================
// MATCHING LOGIC - IMPLEMENTING CAROUSEL ALTERNATIVE (List Message)
// =========================================================================

/**
 * Handles the AI-powered matching process for services or items.
 * Uses a List Message to simulate a rich, scrollable carousel card view.
 * The Gemini prompt is STRICTLY forbidden from including phone numbers.
 */
async function handleMatching(user, senderId) {
    const isService = user.current_flow === 'service_request';
    const flowType = isService ? 'Service Request (Hiring)' : 'Item Purchase (Buying)';
    const category = isService ? user.service_category : user.item_name;
    const summary = isService ? user.description_summary : user.item_description;
    const providerRole = isService ? 'Helpa (Service Provider)' : 'Seller (Product Vendor)';
    
    // --- Gemini Prompt to generate structured match data (CRITICAL CHANGE) ---
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
        2. Generate a JSON object listing exactly *three* potential ${providerRole} matches.
        3. For each match, provide:
           - A Nigerian **Name** (e.g., 'Ayo's Auto Services').
           - A **Title/Category** (e.g., 'Master Plumber' or 'Custom Cake Vendor').
           - A **Detailed Description** (3-4 sentences describing their pricing, services offered, verified rating, and portfolio link - max 80 characters for the description).
           - **NEVER INCLUDE A PHONE NUMBER.**

        Your entire output MUST be a JSON object adhering to the schema below.
    `;
    
    const MATCHING_SCHEMA = {
        type: "OBJECT",
        properties: {
            matches: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        name: { type: "STRING" },
                        title: { type: "STRING" },
                        description: { type: "STRING" },
                        mock_id: { type: "STRING" } // Unique ID for selection
                    }
                }
            }
        }
    };

    let matches = [];
    let searchResponse = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
        contents: [{ parts: [{ text: matchingPrompt }] }],
        tools: [{ "google_search": {} }], 
        config: {
            responseMimeType: "application/json",
            responseSchema: MATCHING_SCHEMA,
        },
    }, { headers: { 'Content-Type': 'application/json' } });

    try {
        const jsonString = searchResponse.data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        // Ensure the mock_id is always present for the next step (simulating phone number retrieval)
        let parsedMatches = JSON.parse(jsonString).matches;
        matches = parsedMatches.map((match, index) => ({
            ...match,
            // Simulating a unique ID that would map to a real phone number in a database
            mock_id: match.mock_id || `MOCK_PH_${isService ? 'H' : 'S'}${index + 1}` 
        }));

    } catch (e) {
        console.error("Failed to parse matches from Gemini:", e.message);
        await sendTextMessage(senderId, "Sorry, I couldn't generate the matches right now. Please try your request again.");
        return;
    }

    // --- Build the List Message (Carousel Alternative) ---
    const listSections = [{
        title: `Top 3 Verified ${providerRole}s`,
        rows: matches.map((match, index) => ({
            id: `SELECT_${isService ? 'HELPA' : 'SELLER'}_${index + 1}`,
            title: `${index + 1} | ${match.name} (${match.title})`,
            description: match.description 
        }))
    }];

    const replyText = `🇳🇬 *Matches Found!* Here are 3 verified ${providerRole}s for your request. Scroll through the options below to see their profile details and select who you want to connect with.`;
    
    // Save the generated matches (the full list)
    user.match_data = JSON.stringify(matches);
    user.status = isService ? 'SERVICE_AWAIT_SELECTION' : 'BUYER_AWAIT_SELECTION';
    await saveUser(user);

    const listPayload = {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: `Best Matches for ${category}` },
            body: { text: replyText },
            action: {
                button: "Select a Provider",
                sections: listSections
            }
        }
    };
    await sendWhatsAppMessage(senderId, listPayload);
}

// =========================================================================
// MESSAGE ROUTER AND FLOW LOGIC (Refactored using AI Intent)
// =========================================================================

function updateUserDetails(user, parsedData) {
    user.service_category = parsedData.service_category;
    user.description_summary = parsedData.description_summary;
    user.city_initial = parsedData.extracted_city;

    let extractedState = parsedData.extracted_state.toLowerCase();
    if (extractedState.includes('oyo')) {
        user.state_initial = 'Oyo';
    } else {
        user.state_initial = 'Lagos'; // Default
    }
    user.budget_initial = parsedData.extracted_budget;
    return user;
}

function buildConfirmationMessage(user, type = 'service') {
    const category = type === 'service' ? user.service_category : user.item_name;
    const summary = type === 'service' ? user.description_summary : user.item_description;
    const budgetDisplay = user.budget_initial || "₦XXXX";

    let message = `*Got it!* You're looking for a *${category}* to help with: _"${summary}"_.\n\n`;

    message += `I see this job/purchase is in *${user.state_initial} State*. `;

    if (user.city_initial) {
        message += `(Specifically the ${user.city_initial} area). `;
    }

    message += `Is this correct, and is your estimated budget/price around *${budgetDisplay}*?`;
    
    return message;
}

/**
 * Main function to handle the user's message and determine the next step.
 */
async function handleMessageFlow(senderId, senderName, message) {
    try {
        let user = await getUserState(senderId);
        let incomingText = message.text?.body || '';
        let interactiveId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || '';
        const lowerText = incomingText.trim().toLowerCase();
        
        let flowInput = interactiveId || lowerText;

        // --- 1. INTENT DETECTION ---
        const intent = await getAIIntent(flowInput.toUpperCase(), user.role); 
        console.log(`[Flow] Detected Intent: ${intent} | Current Status: ${user.status}`);

        // --- 2. NEW USER ONBOARDING ---
        if (user.status === 'NEW' || user.status === 'unassigned' || user.status === 'ERROR' || intent === 'MENU') {
            const menuPayload = getMainMenu(user.role, senderName);
            user.status = 'MAIN_MENU'; // Set to MAIN_MENU to allow AI intent routing on next message
            await saveUser(user);
            await sendWhatsAppMessage(senderId, menuPayload);
            return;
        } 
        
        // --- 3. MAIN MENU ROUTING (Triggered by AI Intent) ---
        else if (user.status === 'MAIN_MENU' || user.status === 'ONBOARDING_ROLE_ASKED') {
            
            switch (intent) {
                // --- Requester Flows (Hire/Buy) ---
                case 'OPT_FIND_SERVICE':
                    user.current_flow = 'service_request';
                    user.status = 'SERVICE_ASK_WHAT';
                    await saveUser(user);
                    const prompt1 = await generateAIResponse("The user is starting the 'Find a professional or service provider' flow. Ask them 'What service do you need, and where? (e.g., A plumber in Ibadan, a graphic designer in Lagos)' in a friendly, conversational tone.");
                    await sendTextMessage(senderId, prompt1);
                    return;
                case 'OPT_BUY_ITEM':
                    user.current_flow = 'buyer_flow';
                    user.status = 'BUYER_ASK_ITEM';
                    await saveUser(user);
                    const prompt2 = await generateAIResponse("The user is starting the 'Buy an item' flow. Ask them 'What item are you looking to buy, and where? (e.g., A used iPhone 12 in Lagos or a custom cake in Ibadan)' in a friendly, conversational tone.");
                    await sendTextMessage(senderId, prompt2);
                    return;

                // --- Provider Flows (Helpa/Seller) ---
                case 'OPT_REGISTER_HELPA':
                    // ANTI-DUPLICATION CHECK: User is already registered as a Helpa or Seller
                    if (user.role === 'helpa' || user.role === 'seller') {
                        const message = await generateAIResponse(`The user is trying to register as a Helpa but their role is already set to ${user.role}. Respond with a polite, brief message (max 2 sentences) confirming their existing role and telling them to use option 6 (Support) to update their profile or list new services.`);
                        await sendTextMessage(senderId, message);
                        return;
                    }
                    user.current_flow = 'helpa_registration';
                    user.status = 'HELPA_ASK_NAME';
                    user.role = 'helpa'; // Set role immediately
                    await saveUser(user);
                    const prompt3 = await generateAIResponse("The user is starting the 'Helpa Registration' flow for Lagos/Oyo. Ask them for their full name and city to begin registration.");
                    await sendTextMessage(senderId, prompt3);
                    return;
                case 'OPT_LIST_ITEM':
                    // ANTI-DUPLICATION CHECK: User is already registered as a Helpa or Seller
                     if (user.role === 'helpa' || user.role === 'seller') {
                        const message = await generateAIResponse(`The user is trying to list an item but their role is already set to ${user.role}. Respond with a polite, brief message (max 2 sentences) confirming their existing role and telling them to use option 6 (Support) to update their profile or list new items.`);
                        await sendTextMessage(senderId, message);
                        return;
                    }
                    user.current_flow = 'seller_registration';
                    user.status = 'SELLER_ASK_PRODUCT';
                    user.role = 'seller'; // Set role immediately
                    await saveUser(user);
                    const prompt4 = await generateAIResponse("The user is starting the 'Seller Registration' flow. Ask them for the name and a short description of the first item they want to list for sale in Lagos/Oyo.");
                    await sendTextMessage(senderId, prompt4);
                    return;

                // --- Account Flows ---
                case 'OPT_MY_ACTIVE':
                    await sendTextMessage(senderId, "The *My Active Jobs/Purchases* feature is under construction! Check back soon. Type MENU to return.");
                    return;
                case 'OPT_SUPPORT':
                    const prompt6 = await generateAIResponse("The user needs support. Acknowledge this and offer a way to contact a human admin using a mock email address: support@yourhelpa.com.");
                    await sendTextMessage(senderId, prompt6);
                    return;

                case 'UNKNOWN':
                    const promptDefault = await generateAIResponse(`The user sent: "${incomingText}". They are at the Main Menu, and the input was unrecognized. Guide them back to choosing a numbered option from the menu, or just type what they need.`);
                    await sendTextMessage(senderId, promptDefault);
                    return;
                
                // Fallthrough for flow-specific intents should be handled below
            }
        } 
        
        // --- FLOW 1: SERVICE REQUEST: ASK WHAT ---
        else if (user.status === 'SERVICE_ASK_WHAT' && incomingText) {
            
            const parsedData = await parseServiceRequest(incomingText);

            if (!parsedData) {
                const retryText = "I had trouble understanding that. Could you please describe the service you need again? E.g., 'A plumber in Ibadan to fix a leaking pipe for ₦15,000.'";
                await sendTextMessage(senderId, retryText);
            } else {
                user = updateUserDetails(user, parsedData);
                user.status = 'SERVICE_CONFIRM_DETAILS'; 
                await saveUser(user);
                
                const bodyText = buildConfirmationMessage(user, 'service');
                const confirmationPayload = getConfirmationButtons(bodyText, "CONFIRM_SERVICE", "CORRECT_SERVICE");
                await sendWhatsAppMessage(senderId, confirmationPayload);
            }
        } 
        
        // --- FLOW 2: BUYER REQUEST: ASK WHAT ---
         else if (user.status === 'BUYER_ASK_ITEM' && incomingText) {
            
            // Re-use the service parser for item details
            const parsedData = await parseServiceRequest(incomingText);

            if (!parsedData) {
                const retryText = "I had trouble understanding that. Could you please describe the item you want to buy again? E.g., 'Looking for a clean, used iPhone 12 in Lagos, budget ₦250,000.'";
                await sendTextMessage(senderId, retryText);
            } else {
                user.item_name = parsedData.service_category; // Use category as item name
                user.item_description = parsedData.description_summary; // Use summary as item description
                user.city_initial = parsedData.extracted_city;

                let extractedState = parsedData.extracted_state.toLowerCase();
                if (extractedState.includes('oyo')) {
                    user.state_initial = 'Oyo';
                } else {
                    user.state_initial = 'Lagos'; // Default
                }
                user.budget_initial = parsedData.extracted_budget;
                
                user.status = 'BUYER_CONFIRM_DETAILS'; 
                await saveUser(user);
                
                const bodyText = buildConfirmationMessage(user, 'item');
                const confirmationPayload = getConfirmationButtons(bodyText, "CONFIRM_ITEM", "CORRECT_ITEM");
                await sendWhatsAppMessage(senderId, confirmationPayload);
            }
        } 
        
        // --- FLOW 1 & 2: CONFIRM DETAILS ---
        else if (user.status.includes('CONFIRM_DETAILS')) {
            const flowType = user.current_flow;
            const isService = flowType === 'service_request';
            const confirmId = isService ? 'CONFIRM_SERVICE' : 'CONFIRM_ITEM';
            const correctId = isService ? 'CORRECT_SERVICE' : 'CORRECT_ITEM';
            const matchStatus = isService ? 'SERVICE_MATCHING' : 'BUYER_MATCHING';
            const correctingStatus = isService ? 'SERVICE_CORRECTING' : 'BUYER_CORRECTING';

            if (intent === confirmId || lowerText.includes('yes')) {
                // CONFIRMED: Move to the matching phase
                user.status = matchStatus;
                await saveUser(user);
                
                const matchType = isService ? 'professionals (Helpas)' : 'sellers';
                await sendTextMessage(senderId, await generateAIResponse(`The user confirmed the request. Give a very quick, excited response (max 2 sentences) and tell them you are now searching for the top 3 verified ${matchType} that match these criteria in Lagos/Oyo.`));
                
                await handleMatching(user, senderId);
                return; 

            } else if (intent === correctId || lowerText.includes('no')) {
                // CORRECTION: Ask for the correction
                user.status = correctingStatus;
                await saveUser(user); 
                const correctionPrompt = "No problem! Please send me the correct details for the request (e.g., 'Change the budget to ₦20,000' or 'It's actually in Lekki, Lagos').";
                await sendTextMessage(senderId, correctionPrompt);
                
            } else {
                // User typed something unexpected when expecting a button click
                const retryText = `Please either click the *YES, Confirm* or *NO, Correct* button to proceed with your request, or type MENU.`;
                await sendTextMessage(senderId, retryText);
            }
        }
        
        // --- FLOW 1 & 2: CORRECTION PROCESSING ---
        else if (user.status.includes('CORRECTING') && incomingText) {
            const flowType = user.current_flow;
            const isService = flowType === 'service_request';
            const confirmStatus = isService ? 'SERVICE_CONFIRM_DETAILS' : 'BUYER_CONFIRM_DETAILS';
            const confirmId = isService ? 'CONFIRM_SERVICE' : 'CONFIRM_ITEM';
            const correctId = isService ? 'CORRECT_SERVICE' : 'CORRECT_ITEM';
            const type = isService ? 'service' : 'item';

            const parsedData = await parseServiceRequest(incomingText);

            if (!parsedData) {
                const retryText = "Sorry, I still didn't get a clear correction. Please send a clear correction (e.g., 'Change the budget to ₦20,000').";
                await sendTextMessage(senderId, retryText);
            } else {
                if (isService) {
                    user = updateUserDetails(user, parsedData);
                } else {
                    // Update buyer details based on correction parse
                    user.item_name = parsedData.service_category; 
                    user.item_description = parsedData.description_summary;
                    user.city_initial = parsedData.extracted_city;
                    user.state_initial = parsedData.extracted_state.toLowerCase().includes('oyo') ? 'Oyo' : 'Lagos';
                    user.budget_initial = parsedData.extracted_budget;
                }
                
                user.status = confirmStatus; // Go back to confirmation state
                await saveUser(user); 
                
                const bodyText = buildConfirmationMessage(user, type);
                const confirmationPayload = getConfirmationButtons(bodyText, confirmId, correctId);
                await sendWhatsAppMessage(senderId, confirmationPayload);
            }
        }
        
        // --- FLOW 1 & 2: AWAITING SELECTION (After Matching) ---
        else if (user.status.includes('AWAIT_SELECTION')) {
            const type = user.current_flow === 'service_request' ? 'Helpa' : 'Seller';
            
            // Selection is made via the List Message's ID (e.g., SELECT_HELPA_1)
            if (flowInput.startsWith('SELECT_')) {
                const selectionIndex = parseInt(flowInput.slice(-1)); // Extracts the number 1, 2, or 3
                const matches = JSON.parse(user.match_data || '[]');

                if (selectionIndex >= 1 && selectionIndex <= matches.length) {
                    const selectedMatch = matches[selectionIndex - 1];
                    
                    // --- REVEAL CONTACT DETAILS (Simulated) ---
                    // Since we didn't generate a real phone number in the prompt, we simulate one for the final connection.
                    // We use a predictable, realistic-looking mock number based on the match name
                    const nameHash = selectedMatch.name.replace(/[^a-zA-Z]/g, '').toUpperCase();
                    const mockPhoneNumber = `+23481${(Math.random() * 10000000).toFixed(0).padStart(7, '0')}`;
                    
                    user.status = 'MAIN_MENU'; 
                    await saveUser(user);
                    
                    const replyText = await generateAIResponse(`The user selected ${selectedMatch.name}. Generate a single, friendly sentence (max 2 sentences) that confirms the selection, and provide the contact information: Name: ${selectedMatch.name}, Title: ${selectedMatch.title}, and the final contact number for connection: ${mockPhoneNumber}.`);
                    await sendTextMessage(senderId, replyText);
                    return;
                }
            }
            
            await sendTextMessage(senderId, `Please select a provider from the list above, or type *MENU* to start over.`);
        }

        // --- ALL OTHER FLOWS (HELPA/SELLER REGISTRATION) ---
        else if (user.status === 'HELPA_ASK_NAME' && incomingText) {
            user.name = incomingText;
            user.status = 'HELPA_ASK_SERVICE';
            await saveUser(user);
            await sendTextMessage(senderId, "Thank you! What is the primary service you offer (e.g., Plumbing, Mobile Car Wash, Tailoring)?");
        }
        else if (user.status === 'HELPA_ASK_SERVICE' && incomingText) {
            user.service_category = incomingText;
            user.status = 'MAIN_MENU';
            await saveUser(user);
            const finalReply = await generateAIResponse(`The user completed Helpa registration with service: ${incomingText}. Give a warm confirmation (max 3 sentences), confirming their Helpa role and noting that their profile is under review for activation.`);
            await sendTextMessage(senderId, finalReply);
        }
        // SELLER REGISTRATION (Simplified for now)
        else if (user.status === 'SELLER_ASK_PRODUCT' && incomingText) {
            user.item_name = incomingText;
            user.status = 'MAIN_MENU';
            await saveUser(user);
            const finalReply = await generateAIResponse(`The user completed Seller registration with item: ${incomingText}. Give a warm confirmation (max 3 sentences), confirming their Seller role and noting that their product listing is pending review.`);
            await sendTextMessage(senderId, finalReply);
        }
        
        // --- DEFAULT FALLBACK ---
        else {
            // If none of the flow states or intents matched, send the menu again
            const menuPayload = getMainMenu(user.role, senderName);
            user.status = 'MAIN_MENU';
            await saveUser(user);
            await sendWhatsAppMessage(senderId, menuPayload);
        }

    } catch (error) {
        console.error("Critical error in handleMessageFlow:", error.message);
        await sendTextMessage(senderId, "A critical system error occurred while processing your request. Please try again later.");
    }
}


// =========================================================================
// EXPRESS SERVER SETUP (unchanged)
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
                    
                    if (message.type === 'text' || message.type === 'interactive') {
                        
                        let logText = message.text?.body || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || 'Interactive Click';
                        
                        console.log(`\n--- YourHelpa: NEW MESSAGE RECEIVED ---`);
                        console.log(`From: ${senderName} (${senderId})`);
                        console.log(`Input: ${logText}`);

                        handleMessageFlow(senderId, senderName, message);
                    }
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
    console.log("✅ AI Intent Detection and List UI Enabled.");
});