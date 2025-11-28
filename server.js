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
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyayObttIKkjMFsem9SHQGfSSft6-MTmI8rKRYyudCmaC_kPLTlLnRTdBw0TU_5RFShitA/exec'; // Placeholder URL

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
        avatar_url: "https://placehold.co/600x400/ff69b4/ffffff?text=Lily+-+Helpa",
        role_description: "Female AI Helper",
    },
    KORE: {
        name: "Kore",
        tone: "calm, assertive, concise, highly professional, and provides direct action-oriented guidance.",
        avatar_url: "https://placehold.co/600x400/007bff/ffffff?text=Kore+-+Helpa",
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
        You must be concise and action-oriented. All responses must be professional but warmly informal and culturally aware (Nigerian context).
        
        **CRITICAL RULE (No Silence Policy):** If a feature is unavailable, or a request cannot be processed, **you must never stay silent**. Instead, provide a friendly explanation about why the request failed or what is missing, and guide the user back to the main menu or a clear action.
        All location references must prioritize Lagos or Oyo State.
    `;
}

// =========================================================================
// GOOGLE APPS SCRIPT & USER STATE MANAGEMENT (Simplified for this flow)
// =========================================================================

// State variables are now heavily used to track the advanced flow stage
const FLOW_STATES = {
    NEW: 'NEW',
    MAIN_MENU: 'MAIN_MENU',
    AUTO_CONFIRM_REQUEST: 'AUTO_CONFIRM_REQUEST', // Confirming the detected request
    AWAIT_LOCATION_CONFIRM: 'AWAIT_LOCATION_CONFIRM', // Confirming user location
    REQUEST_MATCHING: 'REQUEST_MATCHING', // System performing search
    AWAIT_MATCH_SELECTION: 'AWAIT_MATCH_SELECTION', // User selecting a match from the list
    AWAIT_FINAL_CONFIRM: 'AWAIT_FINAL_CONFIRM', // User confirming the selected item/service
    PAYMENT_PENDING: 'PAYMENT_PENDING' // Transaction complete, awaiting payment
};

// Simplified getUserState and saveUser for brevity and focusing on the new logic
// (These functions are copied from the previous step and handle error states gracefully)

async function getUserState(phone) {
    try {
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'GET_STATE',
            phone: phone
        });
        
        if (typeof response.data === 'string' && response.data.startsWith('<!DOCTYPE html>')) {
            console.error("Apps Script GET_STATE failed: Received HTML error page. Using default state.");
             throw new Error("Apps Script returned an HTML error.");
        }
        
        if (response.data.success && response.data.user) {
            if (!response.data.user.preferred_persona) {
                response.data.user.preferred_persona = 'lily'; // Default to Lily
            }
            // Add mock location data if missing
            if (!response.data.user.city_initial) {
                response.data.user.city_initial = 'Ibadan';
                response.data.user.state_initial = 'Oyo';
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
            city: 'Ibadan', 
            state_initial: 'Oyo',
            current_flow: '',
            status: FLOW_STATES.NEW, 
            preferred_persona: 'lily', 
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

async function saveUser(user) {
    try {
        user.item_name = user.service_category;
        user.item_description = user.description_summary;

        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'SAVE_STATE',
            user: user
        });
        
        if (typeof response.data === 'string' && response.data.startsWith('<!DOCTYPE html>')) {
            console.error("Apps Script SAVE_STATE failed: Received HTML error page. Not saved.");
            return;
        }
        
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
// ADVANCED AI INTENT & PARSING
// =========================================================================

const ADVANCED_INTENT_SCHEMA = {
    type: "OBJECT",
    properties: {
        intent: {
            type: "STRING",
            description: "The primary purpose of the user's message.",
            enum: [
                "GREETING", // Simple hi/hello/thanks
                "SERVICE_REQUEST", // Asking to hire a professional/service (e.g., plumber, cleaner)
                "PRODUCT_REQUEST", // Asking to buy a product/item (e.g., phone, cake, car)
                "MENU", // Explicitly asking for the menu/to go back
                "CONFIRM_REQUEST", // User is confirming a suggestion (yes/ok/that's right)
                "CORRECT_REQUEST", // User is correcting a previous detail (no/wrong location/change category)
                "UNKNOWN" // Cannot determine
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
 * Uses Gemini to detect intent and parse request details in one go.
 */
async function getAdvancedIntentAndParse(input, userPersona = 'lily') {
    if (!GEMINI_API_KEY) return { intent: 'UNKNOWN', category: '', description_summary: '', location_city: '' };
    
    // Prioritize explicit button clicks/keywords
    if (input.startsWith('OPT_') || input.startsWith('CONFIRM_') || input.startsWith('CORRECT_') || input.startsWith('SELECT_')) {
        return { intent: input, category: '', description_summary: '', location_city: '' };
    }
    if (input.toUpperCase() === 'MENU' || input.toUpperCase() === 'BACK') {
        return { intent: 'MENU', category: '', description_summary: '', location_city: '' };
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const persona = PERSONAS[userPersona.toUpperCase()];
    
    const parsingInstruction = `
        You are ${persona.name}. The user has sent the message: "${input}".
        
        Task: Determine the user's intent and extract any potential service/product request details, location mentioned, and a summary.
        1. If the message is just a greeting (e.g., 'hi', 'how far', 'good morning'), set intent to GREETING.
        2. If the message clearly asks for a service (e.g., 'I need a carpenter'), set intent to SERVICE_REQUEST.
        3. If the message clearly asks for a product (e.g., 'Where can I buy a cheap mattress'), set intent to PRODUCT_REQUEST.
        4. Extract the 'category', 'description_summary', and 'location_city' if found. Use empty string "" if not found.
        
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


async function generateAIResponse(text, userPersona = 'lily') {
    // (Implementation of generateAIResponse remains the same)
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
        console.error("Error sending message:", error.response?.data || error.message);
    }
}

/**
 * Generates a WhatsApp Interactive Button Message for YES/NO confirmation.
 */
function getConfirmationButtons(bodyText, yesId, noId, footerText, userPersona = 'lily') {
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
 * Sends the Main Menu. (Updated to remove the image for smoother flow if called multiple times)
 */
async function sendMainMenu(senderId, user, senderName) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()] || PERSONAS.LILY;
    const welcomeText = `${persona.name} here! 👋 Welcome back, *${senderName}*. I'm here to connect you with the best services and items in Nigeria.`;
    
    const buttons = [
        { type: "reply", reply: { id: "OPT_FIND_SERVICE", title: "🛠️ Hire Professional" } }, 
        { type: "reply", reply: { id: "OPT_BUY_ITEM", title: "🛍️ Buy/Find Item" } },         
    ];
    
    if (user.role === 'unassigned') {
         buttons.push({ type: "reply", reply: { id: "OPT_REGISTER_ME", title: "🌟 Become a Provider" } }); 
    }
    
    const listSections = [{
        title: "Account & Settings",
        rows: [
            { id: "OPT_MY_ACTIVE", title: "💼 Active Jobs/Listings" }, 
            { id: "OPT_SUPPORT", title: "⚙️ Support/Settings" }, 
            { id: "OPT_CHANGE_PERSONA", title: `🔄 Switch to ${persona.name === 'Lily' ? 'Kore' : 'Lily'}` }
        ]
    }];
    
    // Send initial greeting text
    await sendWhatsAppMessage(senderId, { type: "text", text: { body: welcomeText + "\n\nWhat can I help you find today? Choose an option:" } });
    
    // Send the interactive list menu
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
 * Handles the AI-powered matching process and presents the carousel-like list.
 */
async function sendMatchCarouselList(user, senderId) {
    const isService = user.current_flow === 'service_request';
    const flowType = isService ? 'Service Request (Hiring)' : 'Item Purchase (Buying)';
    const category = user.service_category;
    const providerRole = isService ? 'Helpa (Service Provider)' : 'Seller (Product Vendor)';
    const persona = PERSONAS[user.preferred_persona.toUpperCase()];

    // --- MOCK MATCHING LOGIC ---
    // Instead of calling Gemini, we'll create realistic mock data here based on the request
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
        .filter(m => isService ? m.name.includes('Services') || m.name.includes('Plumbers') || m.name.includes('Electrical') : m.name.includes('Gadgets') || m.name.includes('Cake'))
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

    const replyText = await generateAIResponse(`The user is waiting for the matching result. Respond excitedly (using the ${persona.name} persona) that you have found the top 5 verified ${providerRole}s nearest to them and they should choose one from the list below. Keep it max 2 sentences.`);
    
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
                button: "View Options", // Shortened button text
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
    
    const paymentPrompt = await generateAIResponse(`The user has confirmed the final booking. As ${persona.name}, confirm that you have immediately notified the ${user.current_flow === 'service_request' ? 'Helpa' : 'Seller'} and that the user must now make the payment using the *Monnify Escrow* link below. Explain briefly (max 3 sentences) that the money is held safely until the service/item is delivered and approved by them.`, user.preferred_persona);
    
    const finalMessage = `${paymentPrompt}\n\n*Secure Payment Link (Escrow):*\n${mockMonnifyLink}\n\n*Transaction ID:* ${user.user_id}\n\nType MENU when payment is complete to see next steps.`;

    await sendWhatsAppMessage(senderId, { type: "text", text: { body: finalMessage } });
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
        let interactiveTitle = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
        let interactiveId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || '';
        
        let flowInput = interactiveId || incomingText.trim();
        const persona = PERSONAS[user.preferred_persona.toUpperCase()];

        // --- 1. AI INTENT & PARSING (High priority for text input) ---
        // We use the AI only when it's plain text or an unknown interactive click
        let aiParsed;
        if (interactiveId) {
             aiParsed = { intent: interactiveId, category: '', description_summary: '', location_city: '' };
        } else {
             aiParsed = await getAdvancedIntentAndParse(flowInput, user.preferred_persona);
        }

        const intent = aiParsed.intent;
        console.log(`[Flow] Detected Intent: ${intent} | Current Status: ${user.status} | Persona: ${persona.name}`);

        // --- 2. UNIVERSAL MENU/BACK/RESET ---
        if (intent === 'MENU' || intent === 'OPT_REGISTER_ME' || intent === 'OPT_MY_ACTIVE' || intent === 'OPT_SUPPORT' || intent === 'OPT_CHANGE_PERSONA') {
            user.status = FLOW_STATES.MAIN_MENU; 
            await saveUser(user);
            
            // Handle specific menu clicks that don't need the flow reset
            if (intent === 'OPT_REGISTER_ME' || intent === 'OPT_MY_ACTIVE' || intent === 'OPT_SUPPORT' || intent === 'OPT_CHANGE_PERSONA') {
                // Keep existing simple flows for these specific options (not part of the advanced core)
                 // Just sending the menu will suffice for most, as they need custom handlers
                 await sendMainMenu(senderId, user, senderName);
                 return;
            }

            // General MENU command:
            await sendMainMenu(senderId, user, senderName);
            return;
        }

        // --- 3. GREETING/NEW USER HANDLER ---
        if (user.status === FLOW_STATES.NEW || intent === 'GREETING') {
            user.status = FLOW_STATES.MAIN_MENU; 
            await saveUser(user);
            const greeting = await generateAIResponse(`The user sent a greeting (e.g., 'hi'). Respond courteously, respectfully, and informally (Nigerian context) using the ${persona.name} persona, then ask them what they need help with today.`);
            await sendTextMessage(senderId, greeting);
            // Since the user already sent a greeting, jump into the detection flow if they also had a request, otherwise show menu.
            if (aiParsed.category) {
                 // Fall through to the AUTO_CONFIRM_REQUEST logic below
            } else {
                await sendMainMenu(senderId, user, senderName);
                return;
            }
        }
        
        // --- 4. ADVANCED REQUEST DETECTION (Start of proactive flow) ---
        if (user.status === FLOW_STATES.MAIN_MENU && (intent === 'SERVICE_REQUEST' || intent === 'PRODUCT_REQUEST' || intent === 'OPT_FIND_SERVICE' || intent === 'OPT_BUY_ITEM')) {
            
            // If it was a button click, ensure core fields are set for parsing later
            if (intent === 'OPT_FIND_SERVICE') {
                user.current_flow = 'service_request';
                user.service_category = 'General Service Request'; // Default category
            } else if (intent === 'OPT_BUY_ITEM') {
                user.current_flow = 'buyer_flow';
                user.service_category = 'General Item Request'; // Default category
            } else {
                user.current_flow = (intent === 'SERVICE_REQUEST') ? 'service_request' : 'buyer_flow';
                user.service_category = aiParsed.category || user.service_category;
                user.description_summary = aiParsed.description_summary || user.description_summary;
                user.city_initial = aiParsed.location_city || user.city_initial;
            }
            
            const reqType = user.current_flow === 'service_request' ? 'service' : 'item';
            
            // Build the confirmation message
            let confirmationBody = `Oh, great! You're looking for a *${user.service_category}* ${reqType}. Is this correct?`;
            
            user.status = FLOW_STATES.AUTO_CONFIRM_REQUEST;
            await saveUser(user);
            
            const confirmationPayload = getConfirmationButtons(confirmationBody, "CONFIRM_REQUEST", "MENU", `Confirming your ${reqType} request.`, user.preferred_persona);
            await sendWhatsAppMessage(senderId, confirmationPayload);
            return;
        }

        // --- 5. LOCATION CONFIRMATION (After initial request is confirmed) ---
        if (user.status === FLOW_STATES.AUTO_CONFIRM_REQUEST && intent === 'CONFIRM_REQUEST') {
            
            const mockLocation = user.city_initial || 'Ibadan';
            const locationPrompt = await generateAIResponse(`The user confirmed the request for: ${user.service_category}. As ${persona.name}, ask them to confirm their location, defaulting to their last known location or the location you detected: *${mockLocation}, ${user.state_initial} State*. Ask them to confirm this, or type in a new city/area.`, user.preferred_persona);
            
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
                // Location is already set in user object (mocked)
                // Proceed to search
                user.status = FLOW_STATES.REQUEST_MATCHING;
                await saveUser(user);
                
                await sendTextMessage(senderId, await generateAIResponse(`Location confirmed in ${user.city_initial}. Searching the Helpa database now... this is where we find the best providers for you!`, user.preferred_persona));
                await sendMatchCarouselList(user, senderId);
                return;

            // Handle button click (Correction)
            } else if (intent === 'CORRECT_LOCATION' && !incomingText) {
                // User clicked 'NO, Start Over' (or similar button)
                 await sendTextMessage(senderId, await generateAIResponse(`Okay, no wahala. Type in your correct city and area now (e.g., 'Ikeja' or 'Saki').`, user.preferred_persona));
                 // User status remains AWAIT_LOCATION_CONFIRM
                 return;
            
            // Handle text input (New Location entered)
            } else if (incomingText) {
                const newLocation = incomingText.trim();
                user.city_initial = newLocation.split(',')[0].trim();
                
                // Mock state assignment based on common Nigerian cities
                if (newLocation.toLowerCase().includes('lagos') || newLocation.toLowerCase().includes('ikeja') || newLocation.toLowerCase().includes('lekki')) {
                    user.state_initial = 'Lagos';
                } else if (newLocation.toLowerCase().includes('ibadan') || newLocation.toLowerCase().includes('oyo')) {
                    user.state_initial = 'Oyo';
                } else {
                    user.state_initial = 'Lagos'; // Default
                }

                user.status = FLOW_STATES.REQUEST_MATCHING;
                await saveUser(user);
                
                await sendTextMessage(senderId, await generateAIResponse(`Location successfully updated to *${user.city_initial}, ${user.state_initial} State*. Searching the Helpa database for ${user.service_category} now.`, user.preferred_persona));
                await sendMatchCarouselList(user, senderId);
                return;
            } else {
                 // Fallthrough for unexpected input
                await sendTextMessage(senderId, await generateAIResponse(`Biko, I'm expecting you to confirm your location or type a new one. Try again or type MENU.`, user.preferred_persona));
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
                                      `Are you ready to proceed with booking this ${reqType} and making the escrow payment?`;

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
            const fallbackPrompt = await generateAIResponse(`The user sent: "${incomingText}". I didn't quite catch that. Biko, I am currently waiting for you to select an option from a button or list, or type a clear request/MENU. Please try again.`, user.preferred_persona);
            await sendTextMessage(senderId, fallbackPrompt);
        }


    } catch (error) {
        console.error("Critical error in handleMessageFlow:", error.message);
        // Reset to main menu on critical error
        let user = await getUserState(senderId);
        user.status = FLOW_STATES.MAIN_MENU;
        await saveUser(user);
        await sendTextMessage(senderId, "Biko, something big just went wrong! A critical system error occurred. Please try again later. Type MENU to reset.");
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
    console.log("✅ Chatbot logic upgraded to Advanced Conversational Flow.");
});