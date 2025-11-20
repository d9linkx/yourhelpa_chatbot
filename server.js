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
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyayObttIKkjMFsem9SHQGfSSft6-MTmI8rKRYyudCmaC_kPLTlLnRTdBw0TU_5RFShitA/exec'; // Using the placeholder URL as before

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("CRITICAL ERROR: WhatsApp environment variables are missing.");
    process.exit(1); 
}

// =========================================================================
// PERSONA & RICH MEDIA CONFIGURATION
// =========================================================================

const PERSONAS = {
    LILY: {
        name: "Lily",
        tone: "friendly, enthusiastic, highly empathetic, and uses Nigerian English expressions appropriately.",
        avatar_url: "https://placehold.co/600x400/ff69b4/ffffff?text=Lily+-+YourHelpa+AI",
        role_description: "Female AI Helper",
    },
    KORE: {
        name: "Kore",
        tone: "calm, assertive, concise, highly professional, and provides direct action-oriented guidance.",
        avatar_url: "https://placehold.co/600x400/007bff/ffffff?text=Kore+-+YourHelpa+AI",
        role_description: "Masculine AI Helper",
    }
};

/**
 * Generates the dynamic system instruction for the AI model based on the chosen persona.
 */
function getSystemInstruction(personaName) {
    const persona = PERSONAS[personaName.toUpperCase()] || PERSONAS.LILY;
    
    return `
        You are ${persona.name}, a WhatsApp-based conversational marketplace operating exclusively in **Nigeria**, currently serving users in **Lagos State** and **Oyo State**.
        Your persona is: ${persona.tone}.
        Your primary goal is to facilitate simple and safe transactions for both **Services (Hiring)** and **Items (Buying/Selling)**.
        You must be concise and action-oriented.
        
        **CRITICAL RULE (No Silence Policy):** If a feature is unavailable, or a request cannot be processed, **you must never stay silent**. Instead, provide a friendly explanation about why the request failed or what is missing, and guide the user back to the main menu or a clear action.
        All location references must prioritize Lagos or Oyo State.
    `;
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
    // ... (unchanged logic from previous step, but adding preferred_persona to default)
    try {
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'GET_STATE',
            phone: phone
        });
        
        if (response.data.success && response.data.user) {
            // Ensure preferred_persona is set for existing users
            if (!response.data.user.preferred_persona) {
                response.data.user.preferred_persona = 'lily'; // Default to Lily
            }
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
            preferred_persona: 'lily', // Default to Lily
            row_index: 0,
            service_category: '', 
            description_summary: '', 
            city_initial: '', 
            state_initial: 'Lagos', 
            budget_initial: '', 
            item_name: '', 
            item_description: '',
            match_data: '{}'
        };
    }
}

/**
 * Saves or updates the user profile in Google Sheets.
 * @param {object} user The user object to save.
 */
async function saveUser(user) {
    // ... (unchanged logic from previous step)
    try {
        // Map item fields to unified fields before saving, for clarity
        user.item_name = user.service_category;
        user.item_description = user.description_summary;

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
// GEMINI AI INTEGRATION (Modified to use dynamic System Instruction)
// =========================================================================

// Define the JSON schema for service request parsing (Unchanged)
const SERVICE_REQUEST_SCHEMA = {
  type: "OBJECT",
  properties: {
    service_category: { 
        type: "STRING", 
        description: "A single, normalized category for the service or item (e.g., 'Plumber', 'Tailor', 'iPhone 12', 'Custom Cake'). Must be relevant to Nigerian goods/services." 
    },
    description_summary: { 
        type: "STRING", 
        description: "A very concise summary of the specific job or item requested, max 10 words. Do not repeat the category." 
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
  required: ["service_category", "description_summary", "extracted_state"]
};

// Define the schema for Intent Detection (Unchanged)
const INTENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: { 
        type: "STRING", 
        description: "The most relevant action ID the user is asking for. Must be one of: OPT_FIND_SERVICE, OPT_BUY_ITEM, OPT_REGISTER_ME, OPT_MY_ACTIVE, OPT_SUPPORT, OPT_CHANGE_PERSONA, MENU, UNKNOWN." 
    }
  },
  required: ["intent"]
};

/**
 * Uses Gemini to detect the user's intent from their text input.
 */
async function getAIIntent(input, role, persona) {
    if (!GEMINI_API_KEY) return 'UNKNOWN';
    
    // Check for explicit IDs/Keywords in UPPERCASE since input is passed in UPPERCASE
    if (input.startsWith('OPT_') || input.startsWith('CONFIRM_') || input.startsWith('CORRECT_') || input.startsWith('SELECT_')) return input;
    if (input === 'MENU' || input === 'HI' || input === 'HELLO' || input === 'BACK' || input === '1' || input === '2' || input === '3') return 'MENU'; 

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const parsingInstruction = `
        You are ${persona.name}. The user has sent the following message: "${input}". 
        The user's current role is "${role}".
        Determine the user's intent from the following allowed options:
        - OPT_FIND_SERVICE (for hiring/finding a professional/service)
        - OPT_BUY_ITEM (for buying a product/item)
        - OPT_REGISTER_ME (for offering a service or selling an item - unified entry)
        - OPT_MY_ACTIVE (for checking active jobs/purchases)
        - OPT_SUPPORT (for seeking support or updating a profile)
        - OPT_CHANGE_PERSONA (for changing the AI's persona, e.g., 'talk like a boy')
        - MENU (for returning to the main menu)
        - UNKNOWN (if none of the above apply)
        
        Your entire output MUST be a JSON object adhering to the provided schema.
    `;

    const payload = {
        contents: [{ parts: [{ text: parsingInstruction }] }],
        generationConfig: { 
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
        return 'UNKNOWN'; 
    }
}

/**
 * Calls the Gemini API for conversational responses (Text-to-Text).
 * Now accepts the user's preferred persona.
 */
async function generateAIResponse(text, userPersona = 'lily') {
    if (!GEMINI_API_KEY) return "⚠️ AI Service Error: GEMINI_API_KEY is not configured.";
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const systemPrompt = getSystemInstruction(userPersona);
    
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
        return result.candidates?.[0]?.content?.parts?.[0]?.text || "Eish! Something went wrong, but don't worry, I'm working to fix it. Please type MENU to start over.";

    } catch (error) {
        console.error("Gemini Conversational API Error:", error.response?.data || error.message);
        return "I'm currently experiencing some network issues on the way to my village. Please wait a moment and try sending your message again.";
    }
}

/**
 * Calls the Gemini API for structured output (JSON) for parsing requests and corrections.
 */
async function parseServiceRequest(requestText, currentRequest, flowType, userPersona = 'lily') {
    if (!GEMINI_API_KEY) return null;
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const systemPrompt = getSystemInstruction(userPersona);
    
    const currentCategory = currentRequest.service_category || 'none';
    const currentSummary = currentRequest.description_summary || 'none';
    const currentCity = currentRequest.city_initial || 'none';
    const currentState = currentRequest.state_initial || 'Lagos';
    const currentBudget = currentRequest.budget_initial || 'none';

    // Contextualize the prompt for better accuracy and correction handling
    const parsingInstruction = `${systemPrompt} 
        You are a highly efficient text parsing engine for a ${flowType} request. 
        Analyze the following user input, which could be a brand new request or a correction to an existing request.
        
        Existing Request Details (Use these values unless the new input explicitly changes them):
        - Category: ${currentCategory}
        - Summary: "${currentSummary}"
        - Location City: ${currentCity}
        - Location State: ${currentState}
        - Budget: ${currentBudget}
        
        New User Input: "${requestText}"
        
        Task: 
        1. If this is a correction, update *only* the fields that are explicitly changed by the new input.
        2. If this is a new request, extract all available fields.
        3. Ensure the output is a full JSON object adhering to the schema.
    `;

    const payload = {
        contents: [{ parts: [{ text: parsingInstruction }] }],
        generationConfig: {
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
// WHATSAPP INTERACTIVE MESSAGING FUNCTIONS (Modified for Media)
// =========================================================================

const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

/**
 * Sends a WhatsApp message (text, interactive list, buttons, or image).
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
 * Generates and sends the Main Menu with the AI's persona image.
 */
async function sendMainMenu(senderId, user, senderName) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()] || PERSONAS.LILY;
    const welcomeText = `${persona.name} here, your personal Helpa! 👋 Welcome back, *${senderName}*. I'm here to connect you with the best services and items in Nigeria.`;
    
    const imageCaption = `${welcomeText}\n\nWhat can I help you find today?`;
    
    const buttons = [
        { type: "reply", reply: { id: "OPT_FIND_SERVICE", title: "🛠️ Hire a Professional" } }, 
        { type: "reply", reply: { id: "OPT_BUY_ITEM", title: "🛍️ Buy/Find an Item" } },         
    ];
    
    if (user.role === 'unassigned') {
         buttons.push({ type: "reply", reply: { id: "OPT_REGISTER_ME", title: "🌟 Register as Provider" } }); 
    }
    
    const listSections = [{
        title: "Account & Settings",
        rows: [
            { id: "OPT_MY_ACTIVE", title: "💼 My Active Jobs/Listings" },
            { id: "OPT_SUPPORT", title: "⚙️ Support & Settings" },
            { id: "OPT_CHANGE_PERSONA", title: `🔄 Switch to ${persona.name === 'Lily' ? 'Kore' : 'Lily'}` }
        ]
    }];

    // 1. Send the image first (to make it exciting)
    await sendWhatsAppMessage(senderId, {
        type: "image",
        image: {
            link: persona.avatar_url,
            caption: imageCaption
        }
    });

    // 2. Send the interactive list/buttons right after the image
    const combinedSections = [{
         title: "Quick Actions",
         rows: buttons.map(b => b.reply)
    }, ...listSections];
    
    const menuPayload = {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: `${persona.name}'s Main Menu` },
            body: { text: "Use the list below for quick access to everything!" },
            action: {
                button: "View Options",
                sections: combinedSections
            }
        }
    };
    
    await sendWhatsAppMessage(senderId, menuPayload);
}

/**
 * Generates a WhatsApp Interactive Button Message for YES/NO confirmation.
 */
function getConfirmationButtons(bodyText, yesId, noId, userPersona = 'lily') {
    const persona = PERSONAS[userPersona.toUpperCase()] || PERSONAS.LILY;
    return {
        type: "interactive",
        interactive: {
            type: "button",
            body: { text: bodyText },
            action: {
                buttons: [
                    { type: "reply", reply: { id: yesId, title: "✅ YES, Let's Go" } },
                    { type: "reply", reply: { id: noId, title: `❌ NO, Let Me Correct It` } }
                ]
            },
            footer: { text: `Chatting with ${persona.name}` }
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
// MATCHING LOGIC (Modified for better visual lists)
// =========================================================================

/**
 * Handles the AI-powered matching process for services or items.
 */
async function handleMatching(user, senderId) {
    const isService = user.current_flow === 'service_request';
    const flowType = isService ? 'Service Request (Hiring)' : 'Item Purchase (Buying)';
    const category = user.service_category;
    const summary = user.description_summary;
    const providerRole = isService ? 'Helpa (Service Provider)' : 'Seller (Product Vendor)';
    
    // Use the persona in the matching prompt
    const matchingPrompt = `
        You are a Nigerian Market Intelligence Engine for YourHelpa. The user needs help with a ${flowType}.
        
        Goal: Find 3 top-rated, *mock* ${providerRole}s that match the user's request.
        
        User Request:
        - Category: ${category}
        - Summary: "${summary}"
        - Location: ${user.city_initial || 'Anywhere'}, ${user.state_initial} State
        - Budget: ${user.budget_initial || 'Flexible'}

        Task:
        1. Generate a JSON object listing exactly *three* potential ${providerRole} matches.
        2. For each match, provide:
           - A Nigerian **Name** (e.g., 'Ayo's Auto Services').
           - A **Title/Category** (e.g., 'Master Plumber' or 'Custom Cake Vendor').
           - A **Detailed Description** (max 80 characters, describing their key selling point, a ⭐️ rating, and where they operate).
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
                        mock_id: { type: "STRING" }
                    }
                }
            }
        }
    };

    let matches = [];
    
    let searchResponse;
    try {
        searchResponse = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
            contents: [{ parts: [{ text: matchingPrompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: MATCHING_SCHEMA,
            },
        }, { headers: { 'Content-Type': 'application/json' } });

        const jsonString = searchResponse.data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        let parsedMatches = JSON.parse(jsonString).matches;
        matches = parsedMatches.map((match, index) => ({
            ...match,
            mock_id: match.mock_id || `MOCK_PH_${isService ? 'H' : 'S'}${index + 1}` 
        }));

    } catch (e) {
        console.error("Failed to parse matches from Gemini:", e.message);
        await sendTextMessage(senderId, await generateAIResponse("Ah, my search system hit a small snag while trying to find matches. Please try your request again in a minute, abi? Type MENU to return."));
        return;
    }

    // --- Build the List Message ---
    const listSections = [{
        title: `Top 3 Verified ${providerRole}s`,
        rows: matches.map((match, index) => ({
            id: `SELECT_${isService ? 'HELPA' : 'SELLER'}_${index + 1}`,
            title: `${index + 1}. ${match.name} (${match.title})`,
            description: match.description 
        }))
    }];

    const persona = PERSONAS[user.preferred_persona.toUpperCase()];
    const replyText = await generateAIResponse(`The user is waiting for the matching result. Respond excitedly (using the ${persona.name} persona) that you have found 3 verified ${providerRole}s for their request and they should choose one from the list below. Keep it max 2 sentences.`);
    
    user.match_data = JSON.stringify(matches);
    user.status = 'AWAIT_SELECTION';
    await saveUser(user);

    const listPayload = {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: `Best Matches for ${category}` },
            body: { text: replyText },
            action: {
                button: "View and Select Provider",
                sections: listSections
            },
            footer: { text: `Chatting with ${persona.name}` }
        }
    };
    await sendWhatsAppMessage(senderId, listPayload);
}

// =========================================================================
// MESSAGE ROUTER AND FLOW LOGIC
// =========================================================================

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
        const persona = PERSONAS[user.preferred_persona.toUpperCase()];


        // --- 1. INTENT DETECTION ---
        const intent = await getAIIntent(flowInput.toUpperCase(), user.role, persona); 
        console.log(`[Flow] Detected Intent: ${intent} | Current Status: ${user.status} | Persona: ${persona.name}`);

        // --- 2. MAIN MENU & ONBOARDING ROUTING ---
        if (user.status === 'NEW' || intent === 'MENU') {
            user.status = 'MAIN_MENU'; 
            await saveUser(user);
            await sendMainMenu(senderId, user, senderName);
            return;
        } 
        
        // --- 3. MAIN MENU INTENT HANDLING ---
        else if (user.status === 'MAIN_MENU') {
            
            switch (intent) {
                // --- Persona Switch ---
                case 'OPT_CHANGE_PERSONA':
                    const newPersonaKey = user.preferred_persona === 'lily' ? 'kore' : 'lily';
                    user.preferred_persona = newPersonaKey;
                    await saveUser(user);
                    const newPersona = PERSONAS[newPersonaKey.toUpperCase()];
                    const switchText = await generateAIResponse(`The user has switched to the ${newPersona.name} persona. Greet them in your new persona and confirm the switch is successful, then send the main menu again.`, newPersonaKey);
                    await sendTextMessage(senderId, switchText);
                    await sendMainMenu(senderId, user, senderName);
                    return;

                // --- Requester Flows (Hire/Buy) - UNIFIED START ---
                case 'OPT_FIND_SERVICE':
                case 'OPT_BUY_ITEM':
                    user.current_flow = (intent === 'OPT_FIND_SERVICE') ? 'service_request' : 'buyer_flow';
                    user.status = 'REQUEST_AWAITING_PARSE';
                    
                    const flowPrompt = (intent === 'OPT_FIND_SERVICE') 
                        ? `The user is hiring. As ${persona.name}, ask them: 'What service do you need, and where? (e.g., A plumber in Ibadan, a graphic designer in Lagos)'`
                        : `The user is buying. As ${persona.name}, ask them: 'What item are you looking to buy, and where? (e.g., A used iPhone 12 in Lagos or a custom cake in Ibadan)'`;

                    await saveUser(user);
                    const prompt = await generateAIResponse(flowPrompt, user.preferred_persona);
                    await sendTextMessage(senderId, prompt);
                    return;

                // --- Provider Flows (Registration) ---
                case 'OPT_REGISTER_ME':
                    if (user.role !== 'unassigned') {
                        const message = await generateAIResponse(`The user is trying to register, but their role is already set to ${user.role}. As ${persona.name}, respond with a polite, brief message (max 2 sentences) confirming their existing role and telling them to use the 'Support & Settings' option to update their profile or list a new item/service.`);
                        await sendTextMessage(senderId, message);
                        return;
                    }
                    user.status = 'ASK_PROVIDER_TYPE';
                    await saveUser(user);
                    const regChoiceText = await generateAIResponse(`The user selected 'Register as Provider'. As ${persona.name}, ask them if they want to Offer a Service (Helpa) or Sell an Item (Seller).`);
                    const regChoicePayload = {
                        type: "interactive",
                        interactive: {
                            type: "button",
                            body: { text: regChoiceText },
                            action: {
                                buttons: [
                                    { type: "reply", reply: { id: "OPT_REGISTER_HELPA", title: "Offer a Service (Helpa)" } }, 
                                    { type: "reply", reply: { id: "OPT_LIST_ITEM", title: "Sell an Item (Seller)" } },           
                                    { type: "reply", reply: { id: "MENU", title: "⬅️ Back to Menu" } }                  
                                ]
                            },
                            footer: { text: `Chatting with ${persona.name}` }
                        }
                    };
                    await sendWhatsAppMessage(senderId, regChoicePayload);
                    return;

                case 'OPT_MY_ACTIVE':
                    const activePrompt = await generateAIResponse(`The user selected 'My Active Jobs/Listings'. As ${persona.name}, explain that this feature is currently under construction, and guide them back to the menu.`);
                    await sendTextMessage(senderId, activePrompt);
                    return;
                case 'OPT_SUPPORT':
                    const supportPrompt = await generateAIResponse(`The user needs support. As ${persona.name}, acknowledge this and offer a way to contact a human admin using a mock email address: help@yourhelpa.com. Offer the MENU button.`);
                    await sendWhatsAppMessage(senderId, getConfirmationButtons(supportPrompt, "MENU", "MENU_IGNORED", user.preferred_persona)); 
                    return;

                case 'UNKNOWN':
                    const promptDefault = await generateAIResponse(`The user sent: "${incomingText}". They are at the Main Menu, and the input was unrecognized. As ${persona.name}, politely guide them back to choosing an option from the menu, or just type what they need.`);
                    await sendTextMessage(senderId, promptDefault);
                    return;
            }
        } 
        
        // --- 4. PROVIDER TYPE SELECTION (After Register Me) ---
        else if (user.status === 'ASK_PROVIDER_TYPE') {
            let roleSet = '';
            if (intent === 'OPT_REGISTER_HELPA') {
                user.role = 'helpa';
                roleSet = 'Helpa (Service Provider)';
            } else if (intent === 'OPT_LIST_ITEM') {
                user.role = 'seller';
                roleSet = 'Seller (Product Vendor)';
            }

            if (roleSet) {
                user.status = 'MAIN_MENU';
                await saveUser(user);
                const reply = await generateAIResponse(`The user has successfully set their role to ${roleSet}. As ${persona.name}, welcome them warmly and tell them they should now use the 'Support & Settings' option to fully set up their profile and list their first service/item.`);
                await sendWhatsAppMessage(senderId, getConfirmationButtons(reply, "MENU", "MENU_IGNORED", user.preferred_persona));
                return;
            }
        }
        
        // --- 5. REQUEST FLOW: AWAITING PARSE (Initial Request) ---
        else if (user.status === 'REQUEST_AWAITING_PARSE' && incomingText) {
            // New request - pass empty context {}
            const parsedData = await parseServiceRequest(incomingText, {}, user.current_flow, user.preferred_persona);

            if (!parsedData || !parsedData.service_category) {
                const retryText = await generateAIResponse(`I had trouble understanding that. As ${persona.name}, ask them to please describe their request again, including *what* they need and *where*? (e.g., 'A technician in Yaba, Lagos for TV repair').`);
                await sendTextMessage(senderId, retryText);
            } else {
                user = updateRequestDetails(user, parsedData);
                user.status = 'REQUEST_CONFIRMATION'; 
                await saveUser(user);
                
                const bodyText = buildConfirmationMessage(user);
                const confirmationPayload = getConfirmationButtons(bodyText, "CONFIRM_REQUEST", "CORRECT_REQUEST", user.preferred_persona);
                await sendWhatsAppMessage(senderId, confirmationPayload);
            }
        } 
        
        // --- 6. REQUEST FLOW: CONFIRMATION/CORRECTION BUTTONS ---
        else if (user.status === 'REQUEST_CONFIRMATION') {
            
            if (intent === 'CONFIRM_REQUEST') {
                // CONFIRMED: Move to the matching phase
                user.status = 'REQUEST_MATCHING';
                await saveUser(user);
                
                const matchType = user.current_flow === 'service_request' ? 'professionals (Helpas)' : 'sellers';
                await sendTextMessage(senderId, await generateAIResponse(`The user confirmed the request. As ${persona.name}, give a very quick, excited response (max 2 sentences) and tell them you are now searching for the top 3 verified ${matchType} that match these criteria in Lagos/Oyo.`));
                
                await handleMatching(user, senderId);
                return; 

            } else if (intent === 'CORRECT_REQUEST') {
                // CORRECTION: Ask for the correction
                user.status = 'REQUEST_CORRECTION';
                await saveUser(user); 
                const correctionPrompt = await generateAIResponse(`The user wants to correct the request. As ${persona.name}, acknowledge the request and ask for the correction (e.g., 'The category is actually 'Car Wash' or 'Change the budget to ₦20,000').`);
                await sendTextMessage(senderId, correctionPrompt);
                
            } else {
                // User typed something unexpected when expecting a button click
                const retryText = await generateAIResponse(`The user is stuck in the confirmation loop and sent: "${incomingText}". As ${persona.name}, remind them politely to click the *YES* or *NO* button, or type MENU.`);
                await sendTextMessage(senderId, retryText);
            }
        }
        
        // --- 7. REQUEST FLOW: CORRECTION PROCESSING (Smarter Parse) ---
        else if (user.status === 'REQUEST_CORRECTION' && incomingText) {
            // Pass the user's current request details as context to the AI
            const parsedData = await parseServiceRequest(incomingText, user, user.current_flow, user.preferred_persona);

            if (!parsedData) {
                const retryText = await generateAIResponse(`The user provided a correction: "${incomingText}", but it was unclear. As ${persona.name}, ask them to send a very clear correction (e.g., 'Change the budget to ₦20,000' or 'It's actually in Lekki, Lagos').`);
                await sendTextMessage(senderId, retryText);
            } else {
                user = updateRequestDetails(user, parsedData);
                user.status = 'REQUEST_CONFIRMATION'; // Go back to confirmation state
                await saveUser(user); 
                
                const bodyText = buildConfirmationMessage(user);
                const confirmationPayload = getConfirmationButtons(bodyText, "CONFIRM_REQUEST", "CORRECT_REQUEST", user.preferred_persona);
                await sendWhatsAppMessage(senderId, confirmationPayload);
            }
        }
        
        // --- 8. REQUEST FLOW: AWAITING SELECTION (After Matching) ---
        else if (user.status === 'AWAIT_SELECTION') {
            
            // Selection is made via the List Message's ID (e.g., SELECT_HELPA_1)
            if (flowInput.startsWith('SELECT_')) {
                const selectionIndex = parseInt(flowInput.slice(-1)); 
                const matches = JSON.parse(user.match_data || '[]');

                if (selectionIndex >= 1 && selectionIndex <= matches.length) {
                    const selectedMatch = matches[selectionIndex - 1];
                    
                    // --- REVEAL CONTACT DETAILS (Simulated) ---
                    const mockPhoneNumber = `+23481${(Math.random() * 10000000).toFixed(0).padStart(7, '0')}`;
                    
                    user.status = 'MAIN_MENU'; 
                    await saveUser(user);
                    
                    const replyText = await generateAIResponse(`The user selected ${selectedMatch.name}. As ${persona.name}, generate a single, encouraging sentence (max 2 sentences) that confirms the selection, and provide the contact information: Name: ${selectedMatch.name}, Title: ${selectedMatch.title}, and the final contact number for connection: ${mockPhoneNumber}.`, user.preferred_persona);
                    await sendWhatsAppMessage(senderId, getConfirmationButtons(replyText, "MENU", "MENU_IGNORED", user.preferred_persona));
                    return;
                }
            }
            
            const selectionPrompt = await generateAIResponse(`The user is stuck in the selection screen. As ${persona.name}, remind them to select a provider from the list or type MENU.`);
            await sendTextMessage(senderId, selectionPrompt);
        }

        // --- DEFAULT FALLBACK (Always respond) ---
        else {
            // If none of the flow states or intents matched, send a custom response and the menu again
            const fallbackPrompt = await generateAIResponse(`The user sent: "${incomingText}", but you are in status ${user.status}. As ${persona.name}, explain that you are waiting for a specific type of input (like a button click) and offer the MENU option.`);
            await sendTextMessage(senderId, fallbackPrompt);
            user.status = 'MAIN_MENU';
            await saveUser(user);
            await sendMainMenu(senderId, user, senderName);
        }

    } catch (error) {
        console.error("Critical error in handleMessageFlow:", error.message);
        await sendTextMessage(senderId, "Biko, something big just went wrong! A critical system error occurred. Please try again later. Type MENU to reset.");
    }
}


// =========================================================================
// UTILITY FUNCTIONS (Unchanged from previous step, but included for completeness)
// =========================================================================

/**
 * Updates the unified request fields on the user object.
 * @param {object} user The user object to update.
 * @param {object} parsedData The parsed JSON from the AI.
 * @returns {object} The updated user object.
 */
function updateRequestDetails(user, parsedData) {
    // Only update if the AI returned a non-null or non-empty value, allowing for smart merging
    if (parsedData.service_category && parsedData.service_category !== 'none') {
        user.service_category = parsedData.service_category;
    }
    if (parsedData.description_summary && parsedData.description_summary !== 'none') {
        user.description_summary = parsedData.description_summary;
    }
    if (parsedData.extracted_city && parsedData.extracted_city !== 'none') {
        user.city_initial = parsedData.extracted_city;
    }
    if (parsedData.extracted_state && parsedData.extracted_state !== 'none') {
        let extractedState = parsedData.extracted_state.toLowerCase();
        if (extractedState.includes('oyo')) {
            user.state_initial = 'Oyo';
        } else {
            user.state_initial = 'Lagos'; // Default
        }
    }
    if (parsedData.extracted_budget && parsedData.extracted_budget !== 'none') {
        user.budget_initial = parsedData.extracted_budget;
    }
    
    return user;
}

function buildConfirmationMessage(user) {
    const isService = user.current_flow === 'service_request';
    const type = isService ? 'job' : 'purchase';
    const requestType = isService ? 'service' : 'item';

    const category = user.service_category;
    const summary = user.description_summary;
    const budgetDisplay = user.budget_initial || "Flexible Budget (TBD)";

    let message = `*Got it!* You're requesting a *${category}* ${requestType} summarized as: _"${summary}"_.\n\n`;

    message += `*Location:* ${user.city_initial ? user.city_initial + ', ' : ''}${user.state_initial} State\n`;
    message += `*Budget/Price:* ${budgetDisplay}\n\n`;

    message += `Does this look correct for your ${type} request?`;
    
    return message;
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
    console.log("✅ Rich Media, Persona, and No-Silence Flow Enabled.");
});