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

// --- GOOGLE APPS SCRIPT CONFIGURATION (MANDATORY ENV VARIABLE) ---
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // MUST be set in environment variables

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ CRITICAL ERROR: WhatsApp environment variables (VERIFY_TOKEN, ACCESS_TOKEN, PHONE_NUMBER_ID) are missing.");
    process.exit(1); 
}

if (!APPS_SCRIPT_URL) {
    console.error("❌ CRITICAL ERROR: APPS_SCRIPT_URL environment variable is missing.");
    console.error("Exiting due to missing critical environment variable.");
    process.exit(1);
}


// =========================================================================
// PERSONA & AI CONFIGURATION 
// =========================================================================

const PERSONAS = {
    BUKKY: { 
        name: "Bukky", 
        tone: "super friendly, enthusiastic, and uses clear, informal language. She's your helpful marketplace buddy.", 
        role_description: "Informal AI Helper",
    },
    KORE: {
        name: "Kore",
        tone: "calm, cool, and provides concise, easy-to-understand guidance with an informal vibe. He's efficient but casual.",
        role_description: "Informal AI Helper",
    }
};

/**
 * Generates the dynamic system instruction for the AI model based on the chosen persona.
 */
function getSystemInstruction(personaName) {
    const persona = PERSONAS[personaName.toUpperCase()] || PERSONAS.BUKKY; 
    
    return `
        You are ${persona.name}, a super cool and friendly WhatsApp-based AI helping folks buy, sell, and hire services.
        You only operate in **Nigeria**, specifically **Lagos State** and **Oyo State** for now.
        Your persona is: **${persona.tone}**.
        
        **CRITICAL AI FLOW RULES (CONVERSATION STYLE):**
        1. **Informal & Conversational:** Talk like a friend helping out. Use contractions and keep the tone light.
        2. **Super Brief:** Keep your responses to *1-3 short sentences* max. Don't write paragraphs!
        3. **Action-Oriented:** Always guide the user to the next simple step.
        4. **Nigerian Context:** You understand the local marketplace. Mention local states/cities naturally.

        **CRITICAL RULE (Style):** Use informal, friendly English with contractions (e.g., "I'm," "you'll"). AVOID Nigerian Pidgin English, aggressive slang, or complex technical jargon.
        
        If a feature is unavailable, just say it's "coming soon" in a friendly way, and quickly get them back to the main goal.
    `;
}

// JSON schema for AI Intent Parsing
const BASIC_INTENT_SCHEMA = {
    type: "OBJECT",
    properties: {
        intent: {
            type: "STRING",
            description: "The primary purpose of the user's message.",
            enum: [
                "GREETING", 
                "SERVICE_REQUEST", 
                "PRODUCT_REQUEST", 
                "MENU", 
                "UNKNOWN" 
            ]
        },
        category: { 
            type: "STRING", 
            description: "The specific service or product requested (e.g., 'Plumber', 'Used iPhone 12'). Empty string if not applicable." 
        },
        description_summary: { 
            type: "STRING", 
            description: "A brief summary of the request details, context, or needed location, extracted from the message. Empty string if not applicable." 
        }
    },
    required: ["intent", "category", "description_summary"]
};


/**
 * Uses Gemini to detect intent and parse request details.
 */
async function getBasicIntentAndParse(input) { 
    
    // Quick exit if AI key is missing or input is a known button ID
    const knownIntent = ['OPT_', 'CONFIRM_', 'CORRECT_', 'SELECT_'].find(prefix => input.startsWith(prefix));
    
    if (knownIntent) {
        return { intent: input, category: '', description_summary: '' };
    }
    
    if (input.toUpperCase() === 'MENU' || input.toUpperCase() === 'BACK') {
        return { intent: 'MENU', category: '', description_summary: '' };
    }

    if (!GEMINI_API_KEY) {
        return { intent: 'UNKNOWN', category: '', description_summary: '' };
    }
    
    // --- Using Gemini API for structured JSON output ---
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const parsingInstruction = `
        Task: Determine the user's intent and extract details from the message: "${input}".
        
        Intent Mapping:
        - GREETING: 'hi', 'hello', 'hey', or any simple greeting.
        - SERVICE_REQUEST: 'I need a plumber', 'carpenter needed'.
        - PRODUCT_REQUEST: 'I want a phone', 'sell me a mattress'.
        - MENU: User asked for MENU or BACK.
        - UNKNOWN: Anything else.
        
        Extract the 'category' (e.g., 'Plumber') and a 'description_summary' (brief context/details). Use empty string "" if not found.
        Your entire output MUST be a JSON object adhering to the provided schema.
    `;

    const payload = {
        contents: [{ parts: [{ text: parsingInstruction }] }],
        generationConfig: { 
            responseMimeType: "application/json",
            responseSchema: BASIC_INTENT_SCHEMA,
        },
    };

    try {
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        
        const jsonString = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
        const parsed = JSON.parse(jsonString);
        return parsed;

    } catch (error) {
        console.error("Gemini Basic Parsing API Error:", error.response?.data || error.message);
        return { intent: 'UNKNOWN', category: '', description_summary: '' };
    }
}


/**
 * Uses Gemini to generate conversational, informal responses.
 */
async function generateAIResponse(text, userPersona = 'bukky') { 
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
        return result.candidates?.[0]?.content?.parts?.[0]?.text || "A system error occurred. Please type MENU to start over.";

    } catch (error) {
        console.error("Gemini Conversational API Error:", error.response?.data || error.message);
        return "I am currently experiencing some network issues. Please wait a moment and try sending your message again.";
    }
}


// =========================================================================
// GOOGLE APPS SCRIPT & USER STATE MANAGEMENT 
// =========================================================================

/**
 * Retrieves the user's state from the Apps Script backend.
 */
async function getUserState(phone) {
    try {
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'GET_STATE',
            phone: phone
        });
        
        if (typeof response.data === 'string' && response.data.startsWith('<!DOCTYPE html>')) {
             throw new Error("Apps Script returned an HTML error.");
        }
        
        if (response.data.success && response.data.user) {
            // Initialize defaults if missing
            const user = response.data.user;
            if (!user.preferred_persona) user.preferred_persona = 'bukky'; 
            if (!user.city_initial) user.city_initial = 'Ibadan';
            if (!user.state_initial) user.state_initial = 'Oyo';
            if (!user.current_flow) user.current_flow = 'NEW'; 
            
            return user;
        } else {
            throw new Error("Apps Script returned an unsuccessful response.");
        }

    } catch (e) {
        console.error("❌ APPS SCRIPT COMMUNICATION ERROR (GET_STATE):", e.message);
        // Default user object for new/error state
        return { 
            phone: phone, 
            user_id: `NEW-${Date.now()}`,
            role: 'unassigned', 
            name: '',
            city: 'Ibadan', 
            state_initial: 'Oyo',
            current_flow: 'NEW', // Default to NEW
            preferred_persona: 'bukky',
            row_index: 0,
            service_category: '', 
            description_summary: '', 
            city_initial: 'Ibadan', 
            budget_initial: '', 
            item_name: '', 
            item_description: '',
        };
    }
}

/**
 * Saves the user's state to the Apps Script backend.
 */
async function saveUser(user) {
    try {
        // Map service/description fields for persistence
        user.item_name = user.service_category;
        user.item_description = user.description_summary;

        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'SAVE_STATE',
            user: user
        });
        
        if (typeof response.data === 'string' && response.data.startsWith('<!DOCTYPE html>')) {
            console.error("🚨 APPS SCRIPT FAILURE (SAVE_STATE): Received HTML error page. State NOT saved.");
            return;
        }
        
        if (response.data.success) {
            console.log(`✅ User ${user.phone} state updated to: ${user.current_flow}`);
        } else {
            console.error("🚨 APPS SCRIPT FAILURE (SAVE_STATE): Unsuccessful or malformed response. State NOT saved.", response.data.error || response.data);
        }
        
    } catch (e) {
        console.error("❌ APPS SCRIPT COMMUNICATION ERROR (SAVE_STATE):", e.message);
    }
}


// =========================================================================
// WHATSAPP INTERACTIVE MESSAGING & FLOW FUNCTIONS 
// =========================================================================

const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

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
        console.error("❌ Error sending message to WhatsApp:", error.response?.data || error.message);
    }
}

async function sendTextMessage(to, text) {
    if (!text) return;
    await sendWhatsAppMessage(to, {
        type: "text",
        text: { body: text }
    });
}

function getConfirmationButtons(bodyText, yesId, noId, footerText, userPersona = 'bukky') { 
    return {
        type: "interactive",
        interactive: {
            type: "button",
            body: { text: bodyText },
            action: {
                buttons: [
                    { type: "reply", reply: { id: yesId, title: "✅ YES, Confirm" } },
                    { type: "reply", reply: { id: noId, title: `❌ NO, Start Over` } }
                ]
            },
            footer: { text: footerText || `Chatting with ${userPersona}` }
        }
    };
}


/**
 * Sends the main interactive list menu to the user.
 * @param {string} senderId - WhatsApp ID of the user.
 * @param {object} user - The user state object.
 * @param {string} senderName - The user's profile name.
 * @param {boolean} isFirstTime - True if this is the first interaction (NEW state).
 */
async function sendMainMenu(senderId, user, senderName, isFirstTime = false) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()] || PERSONAS.BUKKY; 
    
    // Crucial fix: Only send the full welcome on the *very* first message.
    let bodyText = isFirstTime 
        ? `Hey *${senderName}*! I'm ${persona.name}, your plug for buying, selling, and hiring services in Lagos and Oyo State. What's the plan?`
        : `I'm ready when you are, *${senderName}*! What's next on the agenda?`;

    const listRows = [
        { id: "OPT_FIND_SERVICE", title: "🛠️ Request a Service" }, 
        { id: "OPT_BUY_ITEM", title: "🛍️ Find an Item" }, 
        { id: "OPT_MY_ACTIVE", title: "💼 Ongoing Transactions" }, 
        { id: "OPT_REPORT_ISSUE", title: "🚨 Report an Issue" }, 
    ];
    
    // Add "Become a Provider" if role is unassigned
    if (user.role === 'unassigned') {
         listRows.push({ id: "OPT_REGISTER_ME", title: "🌟 Become a Provider" }); 
    }
    
    const otherPersonaName = persona.name === 'Bukky' ? 'Kore' : 'Bukky';

    const listSections = [{
        title: "Quick Actions",
        rows: listRows.map(r => ({ id: r.id, title: r.title }))
    }, {
        title: "Settings",
        rows: [
            { id: "OPT_SUPPORT", title: "⚙️ Support/Help" }, 
            { id: "OPT_CHANGE_PERSONA", title: `🔄 Switch to ${otherPersonaName}` }
        ]
    }];
    
    const menuPayload = {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: `${persona.name}'s Main Menu` },
            body: { text: bodyText },
            action: {
                button: "View Options",
                sections: listSections
            },
            footer: { text: "Use the list below for quick access to everything!" }
        }
    };
    
    await sendWhatsAppMessage(senderId, menuPayload);
}

/**
 * Prompts the user to confirm or correct their location.
 */
async function promptForLocation(senderId, user, isServiceFlow, contextualPrompt) {
    const persona = user.preferred_persona;

    // AI text is now EXACTLY tied to the user’s choice
    const aiText = await generateAIResponse(
        contextualPrompt,
        persona
    );

    // Set correct next flow
    user.current_flow = isServiceFlow 
        ? "AWAIT_SERVICE_LOCATION_CONFIRM" 
        : "AWAIT_BUYER_LOCATION_CONFIRM";

    await saveUser(user);

    await sendWhatsAppMessage(senderId, getConfirmationButtons(
        aiText,
        "CONFIRM_LOCATION",
        "CORRECT_LOCATION",
        `Current location: ${user.city_initial}, ${user.state_initial}`,
        persona
    ));
}

    
    const currentFlow = isServiceFlow ? 'AWAIT_SERVICE_LOCATION_CONFIRM' : 'AWAIT_BUYER_LOCATION_CONFIRM';
    user.current_flow = currentFlow; // Set state to AWAIT_LOCATION_CONFIRM
    await saveUser(user);
    
    await sendWhatsAppMessage(senderId, getConfirmationButtons(
        locationPrompt, 
        "CONFIRM_LOCATION", 
        "CORRECT_LOCATION", 
        `Current location: ${user.city_initial}, ${user.state_initial}`,
        user.preferred_persona
    ));
}


// =========================================================================
// MAIN MESSAGE ROUTER 
// =========================================================================

/**
 * Main function to handle the user's message and determine the next step.
 */
async function handleMessageFlow(senderId, senderName, message) {
    try {
        let user = await getUserState(senderId);
        let incomingText = message.text?.body || '';
        let interactiveId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || '';
        
        let flowInput = interactiveId || incomingText.trim();
        let aiParsed = await getBasicIntentAndParse(flowInput);
        const intent = aiParsed.intent;
        
        console.log(`[Flow] Detected Intent: ${intent} | Current Flow: ${user.current_flow}`);
        
        // -----------------------------------------------------------
        // 1. NEW USER / GREETING / MENU COMMAND
        // -----------------------------------------------------------
        if (user.current_flow === 'NEW' || intent === 'MENU' || (user.current_flow === 'MAIN_MENU' && intent === 'GREETING')) {
            const isFirstTime = user.current_flow === 'NEW';
            user.current_flow = 'MAIN_MENU'; 
            await saveUser(user);
            await sendMainMenu(senderId, user, senderName, isFirstTime);
            return;
        }

        // -----------------------------------------------------------
        // 2. MAIN MENU OPTION SELECTION (from MAIN_MENU state)
        // -----------------------------------------------------------
        if (user.current_flow === 'MAIN_MENU' && intent.startsWith('OPT_')) {
            const isService = (intent === 'OPT_FIND_SERVICE');
            
            if (isService || intent === 'OPT_BUY_ITEM') {
                // *** FIX APPLIED HERE: Directly prompt for location without sending the menu again. ***
                await promptForLocation(senderId, user, isService);
                return;
            } 
            
            // Handle Placeholder Options
            if (intent === 'OPT_MY_ACTIVE' || intent === 'OPT_REPORT_ISSUE' || intent === 'OPT_REGISTER_ME' || intent === 'OPT_SUPPORT' || intent === 'OPT_CHANGE_PERSONA') {
                // Generate a brief AI response acknowledging the action
                const prompt = `You selected a non-flow option: ${intent.replace('OPT_', '')}. Acknowledge this selection and mention the feature is coming soon, or confirm the persona switch.`;
                const responseText = await generateAIResponse(prompt, user.preferred_persona);
                await sendTextMessage(senderId, responseText);
                
                // Keep the flow at MAIN_MENU and send the menu again
                await sendMainMenu(senderId, user, senderName, false);
                return;
            }
        }
        
        // -----------------------------------------------------------
        // 3. FALLBACK / UNKNOWN INPUT (if not handled by other flow states later)
        // -----------------------------------------------------------
        if (user.current_flow === 'MAIN_MENU' && intent.startsWith('OPT_')) {

    // Service request flow
    if (intent === 'OPT_FIND_SERVICE') {
        user.selected_option = "SERVICE";
        await promptForLocation(
            senderId,
            user,
            true,  // isServiceFlow
            "Nice! Let's get you the right service provider. First, confirm the location where you need the help."
        );
        return;
    }

    // Product item flow
    if (intent === 'OPT_BUY_ITEM') {
        user.selected_option = "ITEM";
        await promptForLocation(
            senderId,
            user,
            false, // isServiceFlow
            "Got you! I’ll help you find the item. Before I search, can you confirm the location you need it delivered or inspected?"
        );
        return;
    }



    } catch (error) {
        console.error("❌ Critical error in handleMessageFlow:", error.message);
        // Attempt to reset to main menu on critical error
        let user = await getUserState(senderId);
        await sendTextMessage(senderId, "Uh oh, something went wrong on my side! Resetting the conversation. Type MENU to start again.");
        user.current_flow = 'MAIN_MENU';
        await saveUser(user);
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
        console.log('✅ WEBHOOK VERIFIED successfully!');
        res.status(200).send(challenge);
    } else {
        console.error('❌ Webhook verification failed!');
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
    console.log("✅ Main flow fix implemented: Direct transition from menu selection to location prompt without repeating the welcome message.");
});