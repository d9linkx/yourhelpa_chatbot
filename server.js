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
    process.error("Exiting due to missing critical environment variable.");
    process.exit(1);
}


// =========================================================================
// PERSONA & RICH MEDIA CONFIGURATION 
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

// =========================================================================
// GOOGLE APPS SCRIPT & USER STATE MANAGEMENT 
// =========================================================================

// State variables are now heavily used to track the advanced flow stage
const FLOW_STATES = {
    NEW: 'NEW',
    MAIN_MENU: 'MAIN_MENU',
    AUTO_CONFIRM_REQUEST: 'AUTO_CONFIRM_REQUEST', 
    AWAIT_LOCATION_CONFIRM: 'AWAIT_LOCATION_CONFIRM', 
    REQUEST_MATCHING: 'REQUEST_MATCHING', 
    AWAIT_MATCH_SELECTION: 'AWAIT_MATCH_SELECTION', 
    AWAIT_FINAL_CONFIRM: 'AWAIT_FINAL_CONFIRM', 
    PAYMENT_PENDING: 'PAYMENT_PENDING' 
};

/**
 * Retrieves the user's state from the Apps Script backend. (Simulated)
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
            if (!user.status) user.status = FLOW_STATES.NEW; 
            return user;
        } else {
            throw new Error("Apps Script returned an unsuccessful response.");
        }

    } catch (e) {
        console.error("❌ APPS SCRIPT COMMUNICATION ERROR (GET_STATE):", e.message);
        // Default user object for new/error state
        return { 
            phone: phone, 
            user_id: `ERROR-${Date.now()}`,
            role: 'unassigned', 
            name: '',
            city: 'Ibadan', 
            state_initial: 'Oyo',
            current_flow: '',
            status: FLOW_STATES.NEW, 
            preferred_persona: 'bukky',
            row_index: 0,
            service_category: '', 
            description_summary: '', 
            city_initial: 'Ibadan', 
            budget_initial: '', 
            item_name: '', 
            item_description: '',
            match_data: '{}'
        };
    }
}

/**
 * Saves the user's state to the Apps Script backend. (Simulated)
 */
async function saveUser(user) {
    try {
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
            console.log(`✅ User ${user.phone} state updated to: ${user.status}`);
        } else {
            console.error("🚨 APPS SCRIPT FAILURE (SAVE_STATE): Unsuccessful or malformed response. State NOT saved.", response.data.error || response.data);
        }
        
    } catch (e) {
        console.error("❌ APPS SCRIPT COMMUNICATION ERROR (SAVE_STATE):", e.message);
    }
}


// =========================================================================
// GEMINI ADVANCED AI INTENT & PARSING 
// =========================================================================

const ADVANCED_INTENT_SCHEMA = {
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
                "LOCATION_CHANGE", // New intent for location input
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
        },
        location_city: {
            type: "STRING",
            description: "A Nigerian city or area mentioned by the user (e.g., 'Ikeja', 'Ibadan', 'Lekki'). Empty string if not mentioned."
        }
    },
    required: ["intent", "category", "description_summary", "location_city"]
};


/**
 * Uses Gemini to detect intent and parse request details in one go (JSON Mode).
 */
async function getAdvancedIntentAndParse(input, userPersona = 'bukky') { 
    
    if (!GEMINI_API_KEY) return { intent: 'UNKNOWN', category: '', description_summary: '', location_city: '' };
    
    // Prioritize explicit button clicks/keywords
    if (input.startsWith('OPT_') || input.startsWith('CONFIRM_') || input.startsWith('CORRECT_') || input.startsWith('SELECT_')) {
        return { intent: input, category: '', description_summary: '', location_city: '' };
    }
    if (input.toUpperCase() === 'MENU' || input.toUpperCase() === 'BACK') {
        return { intent: 'MENU', category: '', description_summary: '', location_city: '' };
    }

    // --- Using Gemini API for structured JSON output ---
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const parsingInstruction = `
        Task: Determine the user's intent and extract details from the message: "${input}".
        
        Intent Mapping:
        - GREETING: 'hi', 'hello', 'hey'.
        - SERVICE_REQUEST: 'I need a plumber', 'carpenter needed'.
        - PRODUCT_REQUEST: 'I want a phone', 'sell me a mattress'.
        - MENU: User asked for MENU or BACK.
        - LOCATION_CHANGE: User is responding with only a location or a request to change location (e.g., 'Change to Lekki' or 'Saki').
        - UNKNOWN: Anything else.
        
        Extract the 'category' (e.g., 'Plumber'), a 'description_summary' (brief context/details), and 'location_city' (a Nigerian city like 'Ikeja'). Use empty string "" if not found.
        Your entire output MUST be a JSON object adhering to the provided schema.
    `;

    const payload = {
        contents: [{ parts: [{ text: parsingInstruction }] }],
        generationConfig: { 
            responseMimeType: "application/json",
            responseSchema: ADVANCED_INTENT_SCHEMA,
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
        console.error("Gemini Advanced Parsing API Error:", error.response?.data || error.message);
        return { intent: 'UNKNOWN', category: '', description_summary: '', location_city: '' };
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
// WHATSAPP INTERACTIVE MESSAGING FUNCTIONS 
// =========================================================================

const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

async function sendWhatsAppMessage(to, messagePayload) {
    // ... (Omitted for brevity, assumed unchanged)
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

async function sendMainMenu(senderId, user, senderName, isFirstTime = false) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()] || PERSONAS.BUKKY; 
    
    let bodyText = isFirstTime 
        ? `Hey *${senderName}*! I'm ${persona.name}, your plug for buying, selling, and hiring services in Lagos and Oyo State. What's the plan?`
        : `I'm ready when you are, *${senderName}*! What's next on the agenda?`;

    const listRows = [
        { id: "OPT_FIND_SERVICE", title: "🛠️ Hire Professional" }, 
        { id: "OPT_BUY_ITEM", title: "🛍️ Buy/Find Item" },         
    ];
    
    if (user.role === 'unassigned') {
         listRows.push({ id: "OPT_REGISTER_ME", title: "🌟 Become a Provider" }); 
    }
    
    const otherPersonaName = persona.name === 'Bukky' ? 'Kore' : 'Bukky';

    const listSections = [{
        title: "Quick Actions",
        rows: listRows.map(r => ({ id: r.id, title: r.title }))
    }, {
        title: "Account & Settings",
        rows: [
            { id: "OPT_MY_ACTIVE", title: "💼 Active Jobs/Listings" }, 
            { id: "OPT_SUPPORT", title: "⚙️ Support/Settings" }, 
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
 * Handles the AI-powered matching process and presents the carousel-like list.
 */
async function sendMatchCarouselList(user, senderId) {
    const isService = user.current_flow === 'service_request';
    const flowType = isService ? 'Service Request (Hiring)' : 'Item Purchase (Buying)';
    const category = user.service_category;
    const providerRole = isService ? 'Helpa (Service Provider)' : 'Seller (Product Vendor)';
    const persona = PERSONAS[user.preferred_persona.toUpperCase()];

    // --- MOCK MATCHING LOGIC ---
    const mockMatches = [
        { name: "Ayo's Cleaning Services", title: "5-Star Pro Cleaner", price: "₦15,000", quality: "Top-Rated, Eco-Friendly, Background Checked.", description: `We offer deep cleaning for homes and offices. Operates in ${user.city_initial}.` },
        { name: "Tola Gadgets Hub", title: "Used Phones & Accessories", price: "₦250,000", quality: "Certified Refurbished, 6 Month Warranty.", description: `Selling Grade A used iPhones in ${user.city_initial}.` },
        { name: "Ibadan Master Plumbers", title: "Licensed Pipe Repair Specialist", price: "₦10,000 - ₦40,000", quality: "24/7 Service, Fixed Price Quotes.", description: `Expert in leak repair and installations across ${user.city_initial}.` },
        { name: "Lekki Cake Boutique", title: "Custom Birthday Cakes", price: "₦8,500", quality: "Freshly Baked, Free Delivery.", description: `Stunning custom cakes for all occasions. Specializes in Lagos Island.` },
        { name: "Mr. Fix-It Electrical", title: "Certified Electrician", price: "₦5,000 (Service Charge)", quality: "Quick Response, Guaranteed Wiring Safety.", description: `Handles all home and commercial electrical repairs.` }
    ];

    const matches = mockMatches
        .filter(m => isService ? m.name.includes('Cleaning') || m.name.includes('Plumbers') || m.name.includes('Electrical') : m.name.includes('Gadgets') || m.name.includes('Cake'))
        .slice(0, 5)
        .map((match, index) => ({
            ...match,
            mock_id: `${flowType.includes('Service') ? 'HELPA' : 'SELLER'}_${index + 1}`,
            title: `${match.name.substring(0, 15)} | ${match.price}`.substring(0, 24),
            description: `${match.quality} - ${match.description}`.substring(0, 72)
        }));


    // --- Build the List Message (Carousel-like Selection) ---
    const listSections = [{
        title: `Top 5 Verified ${providerRole}s near ${user.city_initial}`,
        rows: matches.map((match, index) => ({
            id: `SELECT_${match.mock_id}`,
            title: match.title, 
            description: match.description 
        }))
    }];

    const replyText = await generateAIResponse(`The user is waiting for the matching result for ${category} in ${user.city_initial}. Announce (using the ${persona.name} persona) that you have found the top 5 verified ${providerRole}s nearest to them and they should choose one from the list below. Be brief and encouraging.`, user.preferred_persona);
    
    // SAVE STATE: Store matches and update status
    user.match_data = JSON.stringify(matches);
    user.status = FLOW_STATES.AWAIT_MATCH_SELECTION;
    await saveUser(user);

    const listPayload = {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: `Best Matches for ${category}`.substring(0, 60) },
            body: { text: replyText },
            action: {
                button: "View Options", 
                sections: listSections
            },
            footer: { text: `Scroll and select the best ${providerRole} for you.` }
        }
    };
    await sendWhatsAppMessage(senderId, listPayload);
}

async function sendPaymentLink(user, senderId) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()];
    const mockMonnifyLink = `https://pay.monnify.com/escrow/payment/${user.user_id}`;
    
    const paymentPrompt = await generateAIResponse(`The user has confirmed the final booking. As ${persona.name}, quickly state that you've notified the ${user.current_flow === 'service_request' ? 'Helpa' : 'Seller'} and the user must now use the *Monnify Escrow* link below to pay. Briefly explain (max 2 sentences) why escrow is safe (money is held until they approve the service/item).`, user.preferred_persona);
    
    const finalMessage = `${paymentPrompt}\n\n*Secure Payment Link (Escrow):*\n${mockMonnifyLink}\n\n*Transaction ID:* ${user.user_id}\n\nType MENU when payment is complete to see next steps.`;

    await sendTextMessage(senderId, finalMessage);
}


// =========================================================================
// STATE HANDLER FUNCTIONS (The brain of the intelligent flow)
// =========================================================================

/**
 * Resets flow data and sends the main menu. Used for explicit MENU/BACK commands.
 */
async function handleFlowReset(senderId, user, senderName, intent) {
    
    if (['OPT_REGISTER_ME', 'OPT_MY_ACTIVE', 'OPT_SUPPORT', 'OPT_CHANGE_PERSONA'].includes(intent)) {
        // --- Handle Non-Flow Menu Options ---
        let tempMessage;
        const persona = PERSONAS[user.preferred_persona.toUpperCase()];

        if (intent === 'OPT_CHANGE_PERSONA') {
            const newPersonaKey = persona.name === 'Bukky' ? 'kore' : 'bukky';
            user.preferred_persona = newPersonaKey; 
            const newPersonaName = PERSONAS[newPersonaKey.toUpperCase()].name;
            tempMessage = await generateAIResponse(`Hello, I'm ${newPersonaName}! I'm your new helper, and I'm ready to find you the best deals.`, newPersonaKey);
        } else {
            tempMessage = await generateAIResponse(`That feature is coming soon! Let's focus on connecting you with a service or item for now.`, user.preferred_persona);
        }
        
        await sendTextMessage(senderId, tempMessage);
        
    } else if (intent === 'CORRECT_REQUEST') {
        // Simple conversational acknowledgement for correction/reset
        await sendTextMessage(senderId, await generateAIResponse("No problem! Let's clear the air and start fresh. What would you like to do now?", user.preferred_persona)); 
    }
    
    // Reset State and send Menu
    user.status = FLOW_STATES.MAIN_MENU; 
    user.current_flow = ''; 
    await saveUser(user);
    await sendMainMenu(senderId, user, senderName, false);
}


/**
 * Handles the initial state and proactive requests.
 */
async function handleNewOrMenuState(senderId, user, senderName, aiParsed) {
    const intent = aiParsed.intent;
    const isFirstTimeUser = user.status === FLOW_STATES.NEW;
    
    // --- Rule 1: First-time user or simple greeting gets the menu ---
    if (isFirstTimeUser || intent === 'GREETING') {
        user.status = FLOW_STATES.MAIN_MENU; 
        await saveUser(user);
        
        // Only send menu if no request was embedded in the greeting
        if (!aiParsed.category) {
            await sendMainMenu(senderId, user, senderName, isFirstTimeUser);
            return;
        }
        // If request *was* embedded (e.g., "Hi, I need a plumber"), fall through to start flow below.
    }
    
    // --- Rule 2: Proactive Request (SERVICE_REQUEST, PRODUCT_REQUEST, or explicit OPT button) ---
    if (intent === 'SERVICE_REQUEST' || intent === 'PRODUCT_REQUEST' || intent === 'OPT_FIND_SERVICE' || intent === 'OPT_BUY_ITEM') {
        
        const isService = (intent === 'OPT_FIND_SERVICE' || intent === 'SERVICE_REQUEST');
        user.current_flow = isService ? 'service_request' : 'buyer_flow';
        
        // Use AI-parsed category or default from button
        user.service_category = aiParsed.category || (isService ? 'General Service Request' : 'General Item Request'); 
        
        // Capture initial details if provided
        if (aiParsed.description_summary) user.description_summary = aiParsed.description_summary;
        if (aiParsed.location_city) user.city_initial = aiParsed.location_city;

        const reqType = isService ? 'service' : 'item';
        const categoryToConfirm = (user.service_category.includes('General') && user.description_summary) 
            ? user.description_summary : user.service_category;
        
        const aiConfirmation = await generateAIResponse(`You're requesting a ${categoryToConfirm} ${reqType}. Is this correct?`, user.preferred_persona);

        let confirmationBody = `${aiConfirmation}\n\n*Request Summary:* ${categoryToConfirm}`;
        
        user.status = FLOW_STATES.AUTO_CONFIRM_REQUEST;
        await saveUser(user);
        
        const confirmationPayload = getConfirmationButtons(confirmationBody, "CONFIRM_REQUEST", "CORRECT_REQUEST", `Confirming your ${reqType} request.`, user.preferred_persona);
        await sendWhatsAppMessage(senderId, confirmationPayload);
        return;
    }
    
    // Fallback if not a greeting or request (e.g., random text in NEW state)
    await handleDefaultOrUnknown(senderId, user);
}


/**
 * Handles the location confirmation and correction phase.
 */
async function handleAwaitingLocation(senderId, user, aiParsed, incomingText) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()];

    // --- Action 1: CONFIRM_LOCATION button clicked ---
    if (aiParsed.intent === 'CONFIRM_LOCATION') {
        user.status = FLOW_STATES.REQUEST_MATCHING;
        await saveUser(user);
        
        await sendTextMessage(senderId, await generateAIResponse(`Location confirmed in ${user.city_initial}. Searching the database now. Hang tight while I find the best matches for you!`, user.preferred_persona)); 
        await sendMatchCarouselList(user, senderId);
        return;
    }
    
    // --- Action 2: CORRECTION / TEXT INPUT / LOCATION_CHANGE intent ---
    if (aiParsed.intent === 'CORRECT_LOCATION' || aiParsed.intent === 'LOCATION_CHANGE' || incomingText) {
        
        let newLocation = incomingText || aiParsed.location_city;
        
        if (newLocation && newLocation !== user.city_initial) {
            
            // AI-powered city/state update
            const lowerLocation = newLocation.toLowerCase();
            user.city_initial = newLocation.split(',')[0].trim();
            
            if (lowerLocation.includes('lagos') || lowerLocation.includes('ikeja') || lowerLocation.includes('lekki') || lowerLocation.includes('surulere')) {
                user.state_initial = 'Lagos';
            } else if (lowerLocation.includes('ibadan') || lowerLocation.includes('oyo')) {
                user.state_initial = 'Oyo';
            } else {
                user.state_initial = 'Lagos'; // Default to Lagos if ambiguous
            }
            
            user.status = FLOW_STATES.REQUEST_MATCHING;
            await saveUser(user);
            
            await sendTextMessage(senderId, await generateAIResponse(`Location successfully updated to *${user.city_initial}, ${user.state_initial} State*. Now searching for the best deals on ${user.service_category}.`, user.preferred_persona)); 
            await sendMatchCarouselList(user, senderId);
            return;

        } else if (aiParsed.intent === 'CORRECT_LOCATION') {
            // User clicked correct location but didn't provide text
             await sendTextMessage(senderId, await generateAIResponse(`Understood. Please type in your correct city and area now (e.g., 'Ikeja' or 'Saki').`, user.preferred_persona)); 
             return;
        }
    }
    
    // Fallback for unexpected input
    await sendTextMessage(senderId, await generateAIResponse(`I am currently waiting for you to *confirm* your location or *type* a new city/area. Please try again.`, user.preferred_persona)); 
}


/**
 * Handles unknown or unexpected messages for the current state.
 */
async function handleDefaultOrUnknown(senderId, user) {
    let guidingMessage;
    
    switch (user.status) {
        case FLOW_STATES.AWAIT_MATCH_SELECTION:
            guidingMessage = "I need you to select one of the matches from the list I sent. Please scroll up and pick one, or type MENU to restart.";
            break;
        case FLOW_STATES.AWAIT_FINAL_CONFIRM:
            guidingMessage = "I'm waiting for your final confirmation before booking the Helpa/Seller. Please use the buttons provided, or type MENU to start over.";
            break;
        case FLOW_STATES.PAYMENT_PENDING:
            guidingMessage = "I'm waiting for your payment to be confirmed through Monnify. Once done, type MENU to see your active job.";
            break;
        case FLOW_STATES.AUTO_CONFIRM_REQUEST:
            guidingMessage = "I'm waiting for you to confirm or correct your request summary using the buttons. Please select one.";
            break;
        default:
            guidingMessage = "I didn't quite catch that. Please type MENU to see the main options or send a clear request like 'plumber near Lekki'.";
            break;
    }
    
    const fallbackPrompt = await generateAIResponse(guidingMessage, user.preferred_persona);
    await sendTextMessage(senderId, fallbackPrompt); 
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

        // --- 1. AI INTENT & PARSING ---
        let aiParsed = await getAdvancedIntentAndParse(flowInput, user.preferred_persona);
        const intent = aiParsed.intent;

        console.log(`[Flow] Detected Intent: ${intent} | Current Status: ${user.status}`);
        
        // --- 2. UNIVERSAL FLOW BREAK / MENU RESET ---
        // This handles all explicit resets (MENU, BACK, CORRECT_REQUEST) and non-flow OPT buttons.
        if (intent.startsWith('MENU') || intent === 'CORRECT_REQUEST' || intent.startsWith('OPT_')) {
            // Note: handleFlowReset automatically saves state and sends the menu.
            await handleFlowReset(senderId, user, senderName, intent);
            return;
        }


        // --- 3. STATE MACHINE: Route message based on current user status ---
        switch (user.status) {
            
            case FLOW_STATES.NEW:
            case FLOW_STATES.MAIN_MENU:
                await handleNewOrMenuState(senderId, user, senderName, aiParsed);
                break;
                
            case FLOW_STATES.AUTO_CONFIRM_REQUEST:
                // Expected: CONFIRM_REQUEST or CORRECT_REQUEST (handled in universal break)
                if (intent === 'CONFIRM_REQUEST') {
                    const mockLocation = user.city_initial || 'Ibadan';
                    const locationPrompt = await generateAIResponse(`Awesome! Just to make sure, is your current location still *${mockLocation}, ${user.state_initial} State*? Confirm below or type your new city/area.`, user.preferred_persona);
                    
                    const bodyText = `${locationPrompt}\n\n*Current Location:* ${mockLocation}, ${user.state_initial} State`;
                    
                    const locationPayload = getConfirmationButtons(bodyText, "CONFIRM_LOCATION", "CORRECT_LOCATION", `Confirming your location.`, user.preferred_persona);
                    user.status = FLOW_STATES.AWAIT_LOCATION_CONFIRM;
                    await saveUser(user);
                    
                    await sendWhatsAppMessage(senderId, locationPayload);
                    
                } else {
                    await handleDefaultOrUnknown(senderId, user);
                }
                break;
                
            case FLOW_STATES.AWAIT_LOCATION_CONFIRM:
                await handleAwaitingLocation(senderId, user, aiParsed, incomingText);
                break;
                
            case FLOW_STATES.REQUEST_MATCHING:
                // User should not be here, re-send the carousel
                await sendMatchCarouselList(user, senderId);
                break;
                
            case FLOW_STATES.AWAIT_MATCH_SELECTION:
                // Expected: SELECT_ (list reply)
                if (intent.startsWith('SELECT_')) {
                    const selectionId = intent.replace('SELECT_', '');
                    const matches = JSON.parse(user.match_data || '[]');
                    const selectedMatch = matches.find(m => m.mock_id === selectionId);
        
                    if (selectedMatch) {
                        user.selected_match = selectedMatch;
                        const reqType = user.current_flow === 'service_request' ? 'Helpa' : 'Seller';
                        
                        const detailMessage = `*Selected ${reqType}:* ${selectedMatch.name} (${selectedMatch.title})\n` +
                                              `*Quality:* ${selectedMatch.quality}\n` +
                                              `*Price:* ${selectedMatch.price}\n\n` +
                                              `Ready to book this ${reqType} and pay through secure escrow?`;
        
                        const finalConfirmPayload = getConfirmationButtons(detailMessage, "CONFIRM_BOOKING_FINAL", "MENU", `Final check before payment.`, user.preferred_persona);
                        
                        user.status = FLOW_STATES.AWAIT_FINAL_CONFIRM;
                        await saveUser(user);
                        await sendWhatsAppMessage(senderId, finalConfirmPayload);
                        return;
                    }
                }
                await handleDefaultOrUnknown(senderId, user);
                break;
                
            case FLOW_STATES.AWAIT_FINAL_CONFIRM:
                // Expected: CONFIRM_BOOKING_FINAL
                if (intent === 'CONFIRM_BOOKING_FINAL') {
                    console.log(`[Transaction] Signaling Provider/Seller: ${user.selected_match.name}`);
                    user.status = FLOW_STATES.PAYMENT_PENDING; 
                    user.user_id = `TXN-${Date.now()}`;
                    await saveUser(user);
                    
                    await sendPaymentLink(user, senderId);
                    
                } else {
                    await handleDefaultOrUnknown(senderId, user);
                }
                break;

            // Default handles PAYMENT_PENDING and any other unexpected state
            default: 
                await handleDefaultOrUnknown(senderId, user);
                break;
        }

    } catch (error) {
        console.error("❌ Critical error in handleMessageFlow (FATAL):", error.message);
        // Attempt to reset to main menu on critical error
        let user = await getUserState(senderId);
        await sendTextMessage(senderId, "Uh oh, something went wrong on my side! Resetting the conversation. Type MENU to start again.");
        user.status = FLOW_STATES.MAIN_MENU;
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
    console.log("✅ Chatbot logic is now running in an intelligent State Machine configuration.");
});