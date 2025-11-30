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
            // Keeping current_flow for basic tracking
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
            user_id: `ERROR-${Date.now()}`,
            role: 'unassigned', 
            name: '',
            city: 'Ibadan', 
            state_initial: 'Oyo',
            current_flow: 'NEW',
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
// GEMINI BASIC AI INTENT & PARSING 
// =========================================================================

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
    
    if (!GEMINI_API_KEY) return { intent: 'UNKNOWN', category: '', description_summary: '' };
    
    // Prioritize explicit button clicks/keywords
    if (input.startsWith('OPT_') || input.startsWith('CONFIRM_') || input.startsWith('CORRECT_') || input.startsWith('SELECT_')) {
        return { intent: input, category: '', description_summary: '' };
    }
    if (input.toUpperCase() === 'MENU' || input.toUpperCase() === 'BACK') {
        return { intent: 'MENU', category: '', description_summary: '' };
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
 * Handles the simple matching process and presents the list.
 */
async function sendMatchList(user, senderId) {
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


    // --- Build the List Message (Selection) ---
    const listSections = [{
        title: `Top 5 Verified ${providerRole}s near ${user.city_initial}`,
        rows: matches.map((match, index) => ({
            id: `SELECT_${match.mock_id}`,
            title: match.title, 
            description: match.description 
        }))
    }];

    const replyText = await generateAIResponse(`I've found the top 5 verified ${providerRole}s nearest to you for ${category} in ${user.city_initial}. Choose the best match from the list below!`, user.preferred_persona);
    
    // Simple state change to track list sent
    user.current_flow = 'await_match_selection';
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
        const persona = PERSONAS[user.preferred_persona.toUpperCase()];
        
        console.log(`[Flow] Detected Intent: ${intent} | Current Flow: ${user.current_flow}`);

        // --- 1. CORE MENU/GREETING HANDLING ---
        if (user.current_flow === 'NEW' || intent === 'MENU' || intent === 'GREETING') {
            user.current_flow = 'MAIN_MENU';
            await saveUser(user);
            await sendMainMenu(senderId, user, senderName, user.current_flow === 'NEW');
            return;
        }

        // --- 2. MAIN MENU OPTIONS (Explicit Button Clicks) ---
        if (intent === 'OPT_FIND_SERVICE' || intent === 'OPT_BUY_ITEM') {
            const isService = (intent === 'OPT_FIND_SERVICE');
            user.current_flow = isService ? 'service_request_category' : 'buyer_flow_category';
            user.service_category = isService ? 'General Service Request' : 'General Item Request'; // Set temporary category
            await saveUser(user);
            
            const prompt = `Great choice! What specific ${isService ? 'service' : 'item'} are you looking for? e.g., 'Plumber' or 'Used iPhone 12'.`;
            await sendTextMessage(senderId, await generateAIResponse(prompt, user.preferred_persona));
            return;
        }

        // --- 3. PROACTIVE REQUEST (AI-Parsed text input) ---
        if (intent === 'SERVICE_REQUEST' || intent === 'PRODUCT_REQUEST') {
            const isService = (intent === 'SERVICE_REQUEST');
            user.current_flow = isService ? 'service_request_location' : 'buyer_flow_location';
            user.service_category = aiParsed.category || (isService ? 'General Service' : 'General Item');
            user.description_summary = aiParsed.description_summary;
            await saveUser(user);

            const categoryToConfirm = (user.service_category.includes('General') && user.description_summary) 
                ? user.description_summary : user.service_category;
            
            const locationPrompt = await generateAIResponse(`Got it! We're looking for *${categoryToConfirm}*. Please confirm your city/area, or type a new one (e.g., 'Ikeja' or 'Saki'). Currently set to *${user.city_initial}*.`, user.preferred_persona);
            
            await sendWhatsAppMessage(senderId, getConfirmationButtons(
                locationPrompt, 
                "CONFIRM_LOCATION", 
                "CORRECT_LOCATION", 
                `Current location: ${user.city_initial}, ${user.state_initial}`,
                user.preferred_persona
            ));
            return;
        }

        // --- 4. FLOW-SPECIFIC HANDLERS ---
        
        // A. Waiting for category input (after clicking OPT_FIND_SERVICE/OPT_BUY_ITEM)
        if (user.current_flow.includes('_category') && incomingText) {
            user.service_category = incomingText.trim();
            user.current_flow = user.current_flow.replace('_category', '_location');
            await saveUser(user);
            
            const locationPrompt = await generateAIResponse(`Thanks! Now, where exactly do you need the ${user.service_category} done? Confirm your city/area, or type a new one. Currently set to *${user.city_initial}*.`, user.preferred_persona);
            
            await sendWhatsAppMessage(senderId, getConfirmationButtons(
                locationPrompt, 
                "CONFIRM_LOCATION", 
                "CORRECT_LOCATION", 
                `Current location: ${user.city_initial}, ${user.state_initial}`,
                user.preferred_persona
            ));
            return;
        }
        
        // B. Location Confirmation/Correction
        if (user.current_flow.includes('_location')) {
            if (intent === 'CONFIRM_LOCATION' || incomingText) {
                
                if (incomingText) {
                    user.city_initial = incomingText.trim().split(',')[0];
                }
                
                await sendTextMessage(senderId, await generateAIResponse(`Location confirmed in *${user.city_initial}*! Searching for the best matches for ${user.service_category} now.`, user.preferred_persona));
                
                // Proceed to matching
                user.current_flow = user.current_flow.replace('_location', '_matching');
                await saveUser(user);
                await sendMatchList(user, senderId);

            } else if (intent === 'CORRECT_LOCATION') {
                 await sendTextMessage(senderId, await generateAIResponse("No worries, please type your correct city and area now (e.g., 'Ikeja' or 'Saki').", user.preferred_persona)); 
            } else {
                await sendTextMessage(senderId, await generateAIResponse("I need you to confirm your location or type in a new one to continue.", user.preferred_persona)); 
            }
            return;
        }
        
        // C. Match Selection (List Reply)
        if (user.current_flow.includes('_matching') && intent.startsWith('SELECT_')) {
            const selectionId = intent.replace('SELECT_', '');
            
            // NOTE: In this simplified flow, we don't store the full match data, just the ID.
            const reqType = user.current_flow.includes('service') ? 'Helpa' : 'Seller';
            
            // Simulating final confirmation
            const finalPrompt = await generateAIResponse(`Great choice! You selected *${selectionId}*. Ready to finalize the booking and move to secure escrow payment?`, user.preferred_persona);
            
            user.current_flow = 'await_payment';
            await saveUser(user);

            await sendWhatsAppMessage(senderId, getConfirmationButtons(
                finalPrompt, 
                "CONFIRM_PAYMENT", 
                "MENU", 
                `Final confirmation for ${reqType}.`,
                user.preferred_persona
            ));
            return;
        }
        
        // D. Final Payment Confirmation
        if (user.current_flow === 'await_payment' && intent === 'CONFIRM_PAYMENT') {
            const mockMonnifyLink = `https://pay.monnify.com/escrow/payment/${senderId.substring(4)}`;
            user.current_flow = 'transaction_complete'; 
            await saveUser(user);

            const paymentPrompt = await generateAIResponse(`Excellent! I've notified the provider/seller. Please use the *Monnify Escrow* link below to pay. Your money is held safely until you confirm the job/item is delivered!`, user.preferred_persona);
    
            const finalMessage = `${paymentPrompt}\n\n*Secure Payment Link (Escrow):*\n${mockMonnifyLink}\n\n*Transaction ID:* TXN-${Date.now()}\n\nType MENU when payment is complete to see your active job.`;

            await sendTextMessage(senderId, finalMessage);
            return;
        }

        // --- 5. FALLBACK / UNKNOWN INTENT ---
        const fallbackPrompt = await generateAIResponse("Sorry, I didn't quite get that. Try typing MENU to see my main options again.", user.preferred_persona);
        await sendTextMessage(senderId, fallbackPrompt);


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
    console.log("✅ Chatbot logic is now running in a simple, linear configuration.");
});