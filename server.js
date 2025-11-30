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

// Gemini API Configuration (Reverting from OpenAI)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 
const GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025';

// --- GOOGLE APPS SCRIPT CONFIGURATION (MANDATORY ENV VARIABLE) ---
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // MUST be set in environment variables

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ CRITICAL ERROR: WhatsApp environment variables (VERIFY_TOKEN, ACCESS_TOKEN, PHONE_NUMBER_ID) are missing.");
    process.exit(1); 
}

if (!APPS_SCRIPT_URL) {
    console.error("❌ CRITICAL ERROR: APPS_SCRIPT_URL environment variable is missing. State management will fail.");
    console.error("INSTRUCTION: Set APPS_SCRIPT_URL to your deployed Google Apps Script Web App URL.");
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
        avatar_url: "https://placehold.co/600x400/ff69b4/ffffff?text=Bukky+-+Helpa",
        role_description: "Informal AI Helper",
    },
    KORE: {
        name: "Kore",
        tone: "calm, cool, and provides concise, easy-to-understand guidance with an informal vibe. He's efficient but casual.",
        avatar_url: "https://placehold.co/600x400/007bff/ffffff?text=Kore+-+Helpa",
        role_description: "Informal AI Helper",
    }
};

/**
 * Generates the dynamic system instruction for the AI model based on the chosen persona.
 */
function getSystemInstruction(personaName) {
    // Default to BUKKY if the name is not found or is empty
    const persona = PERSONAS[personaName.toUpperCase()] || PERSONAS.BUKKY; 
    
    return `
        You are ${persona.name}, a super cool and friendly WhatsApp-based AI helping folks buy, sell, and hire services.
        You only operate in **Nigeria**, specifically **Lagos State** and **Oyo State** for now.
        Your persona is: **${persona.tone}**.
        
        **CRITICAL AI FLOW RULES (CONVERSATION STYLE):**
        1. **Informal & Conversational:** Talk like a friend helping out. Use contractions and keep the tone light.
        2. **Super Brief:** Keep your responses to *1-3 short sentences* max. Don't write paragraphs!
        3. **Action-Oriented:** Always guide the user to the next simple step (e.g., "Gimme your location," or "Which match looks best?").
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
 * Retrieves the user's state from the Apps Script backend.
 */
async function getUserState(phone) {
    try {
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'GET_STATE',
            phone: phone
        });
        
        // CHECK 1: Detect if Google returned an HTML error page (the most common issue)
        if (typeof response.data === 'string' && response.data.startsWith('<!DOCTYPE html>')) {
            console.error("🚨 APPS SCRIPT FAILURE (GET_STATE): Received HTML error page. Check your Apps Script deployment and permissions.");
             throw new Error("Apps Script returned an HTML error.");
        }
        
        // CHECK 2: Validate the JSON response structure
        if (response.data.success && response.data.user) {
            // Initialize defaults if missing
            // Default persona is 'bukky'
            if (!response.data.user.preferred_persona) response.data.user.preferred_persona = 'bukky'; 
            if (!response.data.user.city_initial) {
                response.data.user.city_initial = 'Ibadan';
                response.data.user.state_initial = 'Oyo';
            }
            return response.data.user;
        } else {
            console.error("🚨 APPS SCRIPT FAILURE (GET_STATE): Unsuccessful or malformed response.", response.data.error || response.data);
            throw new Error("Apps Script returned an unsuccessful response.");
        }

    } catch (e) {
        // Log the specific error message from the Apps Script response if available
        const errorMessage = e.response?.data?.error || e.response?.data || e.message;
        console.error("❌ APPS SCRIPT COMMUNICATION ERROR (GET_STATE):", errorMessage);
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
            preferred_persona: 'bukky', // Default is now 'bukky'
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
 * Saves the user's state to the Apps Script backend.
 */
async function saveUser(user) {
    try {
        user.item_name = user.service_category;
        user.item_description = user.description_summary;

        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'SAVE_STATE',
            user: user
        });
        
        // CHECK 1: Detect if Google returned an HTML error page
        if (typeof response.data === 'string' && response.data.startsWith('<!DOCTYPE html>')) {
            console.error("🚨 APPS SCRIPT FAILURE (SAVE_STATE): Received HTML error page. State NOT saved.");
            return;
        }
        
        // CHECK 2: Validate the JSON response structure
        if (response.data.success) {
            console.log(`✅ User ${user.phone} state updated to: ${user.status}`);
        } else {
            console.error("🚨 APPS SCRIPT FAILURE (SAVE_STATE): Unsuccessful or malformed response. State NOT saved.", response.data.error || response.data);
        }
        
    } catch (e) {
        const errorMessage = e.response?.data?.error || e.response?.data || e.message;
        console.error("❌ APPS SCRIPT COMMUNICATION ERROR (SAVE_STATE):", errorMessage);
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
                "CONFIRM_REQUEST", 
                "CORRECT_REQUEST", 
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
            description: "A Nigerian city mentioned by the user (e.g., 'Ikeja', 'Ibadan', 'Lekki'). Empty string if not mentioned."
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
    const persona = PERSONAS[userPersona.toUpperCase()];
    
    const parsingInstruction = `
        You are ${persona.name}. The user has sent the message: "${input}".
        
        Task: Determine the user's intent and extract details.
        1. GREETING: 'hi', 'hello', etc.
        2. SERVICE_REQUEST: 'I need a plumber', 'carpenter needed'.
        3. PRODUCT_REQUEST: 'I want a phone', 'sell me a mattress'.
        4. MENU: User asked for MENU or BACK.
        5. CONFIRM_REQUEST, CORRECT_REQUEST, SELECT_*: These are IDs from buttons, treat them as direct intents.
        6. UNKNOWN: Anything else.
        
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
    
    // --- Using Gemini API for conversational text generation ---
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

/**
 * Helper function for sending simple text messages.
 */
async function sendTextMessage(to, text) {
    if (!text) return;
    await sendWhatsAppMessage(to, {
        type: "text",
        text: { body: text }
    });
}


/**
 * Generates a WhatsApp Interactive Button Message for YES/NO confirmation.
 */
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
 * Sends the Main Menu.
 * @param {string} senderId The WhatsApp ID of the recipient.
 * @param {object} user The user state object.
 * @param {string} senderName The user's name.
 * @param {boolean} isFirstTime If this is the absolute first message sent to the user.
 */
async function sendMainMenu(senderId, user, senderName, isFirstTime = false) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()] || PERSONAS.BUKKY; 
    
    let bodyText;
    if (isFirstTime) {
        // --- Custom Welcome for the first-ever interaction ---
        bodyText = `Hey *${senderName}*! I'm ${persona.name}, your marketplace plug for buying, selling, and hiring services here in Lagos and Oyo State. What's the plan? Choose an option below!`;
    } else {
        // --- Standard message for returning to the menu ---
        bodyText = `I'm ready when you are, *${senderName}*! What's next on the agenda?`;
    }

    // Quick Replies for the Menu (used inside the List Message)
    const listRows = [
        { id: "OPT_FIND_SERVICE", title: "🛠️ Hire Professional" }, 
        { id: "OPT_BUY_ITEM", title: "🛍️ Buy/Find Item" },         
    ];
    
    if (user.role === 'unassigned') {
         listRows.push({ id: "OPT_REGISTER_ME", title: "🌟 Become a Provider" }); 
    }
    
    // Logic for switching persona now correctly identifies if Bukky or Kore is active
    const otherPersonaName = persona.name === 'Bukky' ? 'Kore' : 'Bukky';

    const listSections = [{
        title: "Quick Actions",
        rows: listRows.map(r => ({ id: r.id, title: r.title }))
    }, {
        title: "Account & Settings",
        rows: [
            { id: "OPT_MY_ACTIVE", title: "💼 Active Jobs/Listings" }, 
            { id: "OPT_SUPPORT", title: "⚙️ Support/Settings" }, 
            { id: "OPT_CHANGE_PERSONA", title: `🔄 Switch to ${otherPersonaName}` } // Updated switch text
        ]
    }];
    
    const menuPayload = {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: `${persona.name}'s Main Menu` },
            body: { text: bodyText }, // Use the generated bodyText here
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
 * Handles the AI-powered matching process and presents the carousel-like list (WhatsApp List Message).
 */
async function sendMatchCarouselList(user, senderId) {
    const isService = user.current_flow === 'service_request';
    const flowType = isService ? 'Service Request (Hiring)' : 'Item Purchase (Buying)';
    const category = user.service_category;
    const providerRole = isService ? 'Helpa (Service Provider)' : 'Seller (Product Vendor)';
    const persona = PERSONAS[user.preferred_persona.toUpperCase()];

    // --- MOCK MATCHING LOGIC ---
    // Simulates database search based on request and location (user.city_initial)
    const mockMatches = [
        {
            name: "Ayo's Cleaning Services",
            title: "5-Star Professional Cleaner",
            price: "₦15,000",
            quality: "Top-Rated, Eco-Friendly, Background Checked.",
            description: `We offer deep cleaning for homes and offices. Operates in ${user.city_initial}.`,
        },
        {
            name: "Tola Gadgets Hub",
            title: "Used Phones & Accessories",
            price: "₦250,000",
            quality: "Certified Refurbished, 6 Month Warranty.",
            description: `Selling Grade A used iPhones in ${user.city_initial}.`,
        },
        {
            name: "Ibadan Master Plumbers",
            title: "Licensed Pipe Repair Specialist",
            price: "₦10,000 - ₦40,000",
            quality: "24/7 Service, Fixed Price Quotes.",
            description: `Expert in leak repair and installations across ${user.city_initial}.`,
        },
        {
            name: "Lekki Cake Boutique",
            title: "Custom Birthday Cakes",
            price: "₦8,500",
            quality: "Freshly Baked, Free Delivery in Lekki.",
            description: `Stunning custom cakes for all occasions. Specializes in Lagos Island.`,
        },
        {
            name: "Mr. Fix-It Electrical",
            title: "Certified Electrician",
            price: "₦5,000 (Service Charge)",
            quality: "Quick Response, Guaranteed Wiring Safety.",
            description: `Handles all home and commercial electrical repairs.`,
        }
    ];

    // Filter to be more relevant and only take top 5
    const matches = mockMatches
        .filter(m => isService ? m.name.includes('Services') || m.name.includes('Plumbers') || m.name.includes('Electrical') || m.name.includes('Fix-It') : m.name.includes('Gadgets') || m.name.includes('Cake'))
        .slice(0, 5)
        .map((match, index) => ({
            ...match,
            mock_id: `${flowType.includes('Service') ? 'HELPA' : 'SELLER'}_${index + 1}`,
            // Ensure title is short for WhatsApp list message
            title: `${match.name.substring(0, 15)} | ${match.price}`.substring(0, 24),
            // Combine quality and description for the list description field
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

    // Enhanced prompt for smoother, less repetitive language
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

/**
 * Provides a mock Monnify payment link for the escrow process.
 */
async function sendPaymentLink(user, senderId) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()];
    
    // Mock Monnify Payment Link
    const mockMonnifyLink = `https://pay.monnify.com/escrow/payment/${user.user_id}`;
    
    // Enhanced prompt for smoother, less repetitive language
    const paymentPrompt = await generateAIResponse(`The user has confirmed the final booking. As ${persona.name}, quickly state that you've notified the ${user.current_flow === 'service_request' ? 'Helpa' : 'Seller'} and the user must now use the *Monnify Escrow* link below to pay. Briefly explain (max 2 sentences) why escrow is safe (money is held until they approve the service/item).`, user.preferred_persona);
    
    // Updated to use clean English for explanation
    const finalMessage = `${paymentPrompt}\n\n*Secure Payment Link (Escrow):*\n${mockMonnifyLink}\n\n*Transaction ID:* ${user.user_id}\n\nType MENU when payment is complete to see next steps.`;

    await sendTextMessage(senderId, finalMessage);
}


// =========================================================================
// MESSAGE ROUTER AND ADVANCED FLOW LOGIC 
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
        const persona = PERSONAS[user.preferred_persona.toUpperCase()] || PERSONAS.BUKKY; 

        // --- 1. AI INTENT & PARSING ---
        let aiParsed;
        if (interactiveId) {
             aiParsed = { intent: interactiveId, category: '', description_summary: '', location_city: '' };
        } else {
             // Use Gemini for intent parsing
             aiParsed = await getAdvancedIntentAndParse(flowInput, user.preferred_persona);
        }

        const intent = aiParsed.intent;
        console.log(`[Flow] Detected Intent: ${intent} | Current Status: ${user.status} | Persona: ${persona.name}`);
        
        // --- 2. UNIVERSAL MENU/BACK/RESET ---
        if (intent.startsWith('MENU') || intent.startsWith('OPT_') || intent === 'CORRECT_REQUEST') {
            
            // Flag to determine if this is a first-time greeting transition
            const isFirstTimeUser = user.status === FLOW_STATES.NEW;
            
            // Handle specific menu clicks that DO NOT reset the state
            if (['OPT_REGISTER_ME', 'OPT_MY_ACTIVE', 'OPT_SUPPORT', 'OPT_CHANGE_PERSONA'].includes(intent)) {
                 // Send a temporary message indicating these options are TBD
                 const tempMessage = await generateAIResponse(`That feature is coming soon! Don't worry, we're working on it. Let's focus on connecting you with a service or item for now. Type MENU to see the options again.`, user.preferred_persona);
                 await sendTextMessage(senderId, tempMessage);
                 // Send menu immediately after the TBD message (isFirstTimeUser must be false here)
                 await sendMainMenu(senderId, user, senderName, false); 
                 return; // CRITICAL FIX: Ensure flow ends here after handling action
            }

            // General MENU command:
            
            // Only reset status to MAIN_MENU if we are not handling a special flow option
            user.status = FLOW_STATES.MAIN_MENU; 
            user.current_flow = ''; // Reset flow type
            await saveUser(user);
            
            await sendMainMenu(senderId, user, senderName, isFirstTimeUser);
            return;
        }

        // --- 3. GREETING/NEW USER HANDLER ---
        if (user.status === FLOW_STATES.NEW || intent === 'GREETING') {
            
            const isFirstTimeUser = user.status === FLOW_STATES.NEW;
            
            // 3b. Update status and save
            user.status = FLOW_STATES.MAIN_MENU; 
            await saveUser(user);
            
            // 3c. If the user only sent a greeting, show the menu.
            if (!aiParsed.category && aiParsed.intent === 'GREETING') {
                // Now, sendMainMenu is the first message (isFirstTimeUser is true)
                await sendMainMenu(senderId, user, senderName, isFirstTimeUser);
                return;
            }
            // If the user included a request (e.g., "Hi, cleaner"), execution will fall through to step 4 below.
            if (!aiParsed.category) {
                 return;
            }
        }
        
        // --- 4. ADVANCED REQUEST DETECTION (Start of proactive flow) ---
        if (user.status === FLOW_STATES.MAIN_MENU && (intent === 'SERVICE_REQUEST' || intent === 'PRODUCT_REQUEST' || intent === 'OPT_FIND_SERVICE' || intent === 'OPT_BUY_ITEM')) {
            
            // Set flow type based on button click or AI intent
            if (intent === 'OPT_FIND_SERVICE' || intent === 'SERVICE_REQUEST') {
                user.current_flow = 'service_request';
                user.service_category = aiParsed.category || 'General Service Request'; 
            } else { // OPT_BUY_ITEM or PRODUCT_REQUEST
                user.current_flow = 'buyer_flow';
                user.service_category = aiParsed.category || 'General Item Request'; 
            }
            
            // Capture any initial description/location from the same message
            if (aiParsed.description_summary) user.description_summary = aiParsed.description_summary;
            if (aiParsed.location_city) user.city_initial = aiParsed.location_city;

            const reqType = user.current_flow === 'service_request' ? 'service' : 'item';
            
            // Build the confirmation message
            const categoryToConfirm = (user.service_category.includes('General') && user.description_summary) ? user.description_summary : user.service_category;
            
            // Use AI to generate the natural-sounding confirmation text
            const aiConfirmation = await generateAIResponse(`The user is requesting a ${categoryToConfirm} ${reqType}. As ${persona.name}, acknowledge this and politely ask for confirmation. Be conversational and very brief.`, user.preferred_persona);

            let confirmationBody = `${aiConfirmation}\n\n*Request Summary:* ${categoryToConfirm}`;
            
            user.status = FLOW_STATES.AUTO_CONFIRM_REQUEST;
            await saveUser(user);
            
            const confirmationPayload = getConfirmationButtons(confirmationBody, "CONFIRM_REQUEST", "CORRECT_REQUEST", `Confirming your ${reqType} request.`, user.preferred_persona);
            await sendWhatsAppMessage(senderId, confirmationPayload);
            return;
        }

        // --- 5. LOCATION CONFIRMATION (After initial request is confirmed) ---
        if (user.status === FLOW_STATES.AUTO_CONFIRM_REQUEST && intent === 'CONFIRM_REQUEST') {
            
            const mockLocation = user.city_initial || 'Ibadan';
            
            // Enhanced prompt for smoother, less repetitive language
            const locationPrompt = await generateAIResponse(`The user confirmed the request. As ${persona.name}, ask them to confirm their current location or provide a new one. Their current known location is *${mockLocation}, ${user.state_initial} State*. Be brief and action-oriented.`, user.preferred_persona);
            
            const bodyText = `${locationPrompt}\n\n*Current Location:* ${mockLocation}, ${user.state_initial} State`;
            
            const locationPayload = getConfirmationButtons(bodyText, "CONFIRM_LOCATION", "CORRECT_LOCATION", `Confirming your location.`, user.preferred_persona);
            user.status = FLOW_STATES.AWAIT_LOCATION_CONFIRM;
            await saveUser(user);
            
            await sendWhatsAppMessage(senderId, locationPayload);
            return;
        }

        // --- 6. SEARCH & MATCHING (After location is confirmed/corrected) ---
        if (user.status === FLOW_STATES.AWAIT_LOCATION_CONFIRM) {
            
            // Handle button click (Use Current Location)
            if (intent === 'CONFIRM_LOCATION') {
                user.status = FLOW_STATES.REQUEST_MATCHING;
                await saveUser(user);
                
                await sendTextMessage(senderId, await generateAIResponse(`Location confirmed in ${user.city_initial}. Searching the database now. Hang tight while I find the best matches for you!`, user.preferred_persona)); 
                await sendMatchCarouselList(user, senderId);
                return;

            // Handle button click (Correction)
            } else if (intent === 'CORRECT_LOCATION' && !incomingText) {
                // User clicked 'NO, Start Over' (or similar button)
                 await sendTextMessage(senderId, await generateAIResponse(`Understood. Please type in your correct city and area now (e.g., 'Ikeja' or 'Saki').`, user.preferred_persona)); 
                 return;
            
            // Handle text input (New Location entered)
            } else if (incomingText) {
                const newLocation = incomingText.trim();
                user.city_initial = newLocation.split(',')[0].trim();
                
                // Mock state assignment
                const lowerLocation = newLocation.toLowerCase();
                if (lowerLocation.includes('lagos') || lowerLocation.includes('ikeja') || lowerLocation.includes('lekki') || lowerLocation.includes('surulere')) {
                    user.state_initial = 'Lagos';
                } else if (lowerLocation.includes('ibadan') || lowerLocation.includes('oyo')) {
                    user.state_initial = 'Oyo';
                } else {
                    user.state_initial = 'Lagos'; // Default
                }

                user.status = FLOW_STATES.REQUEST_MATCHING;
                await saveUser(user);
                
                await sendTextMessage(senderId, await generateAIResponse(`Location successfully updated to *${user.city_initial}, ${user.state_initial} State*. Now searching for the best deals on ${user.service_category}.`, user.preferred_persona)); 
                await sendMatchCarouselList(user, senderId);
                return;
            } else {
                 // Fallthrough for unexpected input
                await sendTextMessage(senderId, await generateAIResponse(`I am expecting you to confirm your location or type a new one. Please try again or type MENU.`, user.preferred_persona)); 
                return;
            }
        }
        
        // --- 7. FINAL ITEM CONFIRMATION (After selecting from the list) ---
        if (user.status === FLOW_STATES.AWAIT_MATCH_SELECTION && intent.startsWith('SELECT_')) {
            const selectionId = intent.replace('SELECT_', '');
            const matches = JSON.parse(user.match_data || '[]');
            const selectedMatch = matches.find(m => m.mock_id === selectionId);

            if (selectedMatch) {
                user.selected_match = selectedMatch;
                const reqType = user.current_flow === 'service_request' ? 'Helpa' : 'Seller';
                
                // Detailed Description for final confirmation
                const detailMessage = `*Selected ${reqType}:* ${selectedMatch.name} (${selectedMatch.title})\n` +
                                      `*Quality:* ${selectedMatch.quality}\n` +
                                      `*Price:* ${selectedMatch.price}\n\n` +
                                      `*Description:* ${selectedMatch.description}\n\n` +
                                      `Ready to book this ${reqType} and pay through escrow?`;

                const finalConfirmPayload = getConfirmationButtons(detailMessage, "CONFIRM_BOOKING_FINAL", "MENU", `Final check before payment.`, user.preferred_persona);
                
                user.status = FLOW_STATES.AWAIT_FINAL_CONFIRM;
                await saveUser(user);
                await sendWhatsAppMessage(senderId, finalConfirmPayload);
                return;
            }
        }
        
        // --- 8. PAYMENT AND PROVIDER SIGNAL ---
        if (user.status === FLOW_STATES.AWAIT_FINAL_CONFIRM && intent === 'CONFIRM_BOOKING_FINAL') {
            
            // --- 1. Signal Provider (Mocked) ---
            console.log(`[Transaction] Signaling Provider/Seller: ${user.selected_match.name}`);
            
            // --- 2. Send Payment Link ---
            user.status = FLOW_STATES.PAYMENT_PENDING; 
            user.user_id = `TXN-${Date.now()}`; // Generate a mock TXN ID
            await saveUser(user);
            
            await sendPaymentLink(user, senderId);
            return;
        }

        // --- 9. DEFAULT FALLBACK / UNKNOWN INPUT ---
        if (intent === 'UNKNOWN' || (user.status !== FLOW_STATES.MAIN_MENU && !interactiveId)) {
            // Enhanced prompt for smoother, less robotic language
            const fallbackPrompt = await generateAIResponse(`I didn't quite catch that. I'm waiting for you to select an option from a button or list, or type a clear request or MENU. Let's try that again!`, user.preferred_persona);
            await sendTextMessage(senderId, fallbackPrompt); 
        }


    } catch (error) {
        console.error("❌ Critical error in handleMessageFlow (FATAL):", error.message);
        // Attempt to reset to main menu on critical error
        let user = await getUserState(senderId);
        user.status = FLOW_STATES.MAIN_MENU;
        await saveUser(user);
        await sendTextMessage(senderId, "Uh oh, something went wrong on my side! Type MENU to reset and let's try again.");
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
    console.log(`Webhook URL: https://yourhelpa-chatbot.onrender.com/webhook`);
    console.log("✅ Chatbot logic is highly resilient and ready for the Advanced Conversational Flow.");
});