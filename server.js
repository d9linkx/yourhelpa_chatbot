// server.js - Clean rewrite for YourHelpa WhatsApp bot
// -----------------------------------------------------------------------------
// Required modules
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();

// -----------------------------------------------------------------------------
// Critical configuration (environment variables)
const PORT = process.env.PORT || 5000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // required
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025'; // keep as configured

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ CRITICAL ERROR: WhatsApp env variables (VERIFY_TOKEN, ACCESS_TOKEN, PHONE_NUMBER_ID) are missing.");
    process.exit(1);
}
if (!APPS_SCRIPT_URL) {
    console.error("❌ CRITICAL ERROR: APPS_SCRIPT_URL environment variable is missing.");
    process.exit(1);
}

// -----------------------------------------------------------------------------
// Personas & system prompt generation
const PERSONAS = {
    BUKKY: {
        name: "Bukky",
        tone: "super friendly, enthusiastic, and uses clear, informal language. She's your helpful marketplace buddy.",
        role_description: "Informal AI Helper"
    },
    KORE: {
        name: "Kore",
        tone: "calm, cool, and provides concise, easy-to-understand guidance with an informal vibe. He's efficient but casual.",
        role_description: "Informal AI Helper"
    }
};

function getSystemInstruction(personaName = 'bukky') {
    const persona = PERSONAS[personaName.toUpperCase()] || PERSONAS.BUKKY;
    return `
You are ${persona.name}, a super cool and friendly WhatsApp-based AI helping folks buy, sell, and hire services.
You only operate in Nigeria, specifically Lagos State and Oyo State for now.
Your persona is: ${persona.tone}

CRITICAL AI FLOW RULES (CONVERSATION STYLE):
1. Informal & Conversational: Talk like a friend helping out. Use contractions and keep the tone light.
2. Super Brief: Keep your responses to 1-3 short sentences max.
3. Action-Oriented: Always guide the user to the next simple step.
4. Nigerian Context: Mention local states/cities naturally.

Style rule: Use informal, friendly English with contractions. AVOID Nigerian Pidgin English, aggressive slang, or complex technical jargon.

If a feature is unavailable, say it's "coming soon" in a friendly way and quickly get back to the main goal.
`;
}

// -----------------------------------------------------------------------------
// Intent parsing schema (used with Gemini if available)
const BASIC_INTENT_SCHEMA = {
    type: "OBJECT",
    properties: {
        intent: { type: "STRING",
            description: "Primary purpose of the user's message.",
            enum: ["GREETING","SERVICE_REQUEST","PRODUCT_REQUEST","MENU","UNKNOWN"]
        },
        category: { type: "STRING", description: "Specific service/product" },
        description_summary: { type: "STRING", description: "Brief contextual summary" }
    },
    required: ["intent","category","description_summary"]
};

// -----------------------------------------------------------------------------
// Gemini helpers (if GEMINI_API_KEY is configured)
async function generateAIResponse(text, userPersona = 'bukky') {
    if (!GEMINI_API_KEY) {
        return "⚠️ AI Service Error: GEMINI_API_KEY is not configured.";
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const systemPrompt = getSystemInstruction(userPersona);

    const payload = {
        contents: [{ parts: [{ text: text }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
    };

    try {
        const resp = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        const candidateText = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        return candidateText || "A system error occurred. Please type MENU to start over.";
    } catch (err) {
        console.error("Gemini Conversational API Error:", err.response?.data || err.message);
        return "I am currently experiencing some network issues. Please try again in a moment.";
    }
}

async function getBasicIntentAndParse(input) {
    // Quick checks for button/list ids or MENU/BACK
    if (!input || typeof input !== 'string') {
        return { intent: 'UNKNOWN', category: '', description_summary: '' };
    }

    const BUTTON_PREFIXES = ['OPT_', 'CONFIRM_', 'CORRECT_', 'SELECT_'];
    for (const p of BUTTON_PREFIXES) {
        if (input.startsWith(p)) {
            return { intent: input, category: '', description_summary: '' };
        }
    }

    const normalized = input.trim().toUpperCase();
    if (normalized === 'MENU' || normalized === 'BACK') {
        return { intent: 'MENU', category: '', description_summary: '' };
    }

    // If no Gemini key, fallback
    if (!GEMINI_API_KEY) {
        // Basic heuristics fallback
        if (/^(hi|hello|hey|hello there|good morning|good afternoon)/i.test(input)) {
            return { intent: 'GREETING', category: '', description_summary: '' };
        }
        if (/plumber|carpenter|electrician|service|hire/i.test(input)) {
            return { intent: 'SERVICE_REQUEST', category: '', description_summary: input };
        }
        if (/buy|sell|want|sell me|looking for|used|phone|mattress/i.test(input)) {
            return { intent: 'PRODUCT_REQUEST', category: '', description_summary: input };
        }
        return { intent: 'UNKNOWN', category: '', description_summary: '' };
    }

    // Use Gemini structured generation if available
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const parsingInstruction = `
Task: Determine intent & extract details from: "${input}".
Intent mapping:
- GREETING: "hi","hello","hey"
- SERVICE_REQUEST: request for a worker/professional
- PRODUCT_REQUEST: buying/selling an item
- MENU: asks for MENU/BACK
- UNKNOWN: otherwise
Return a JSON object that matches the schema.
    `;

    const payload = {
        contents: [{ parts: [{ text: parsingInstruction }] }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: BASIC_INTENT_SCHEMA
        }
    };

    try {
        const resp = await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' } });
        const jsonText = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!jsonText) throw new Error("Empty schema response");
        const parsed = JSON.parse(jsonText);
        return parsed;
    } catch (err) {
        console.error("Gemini Basic Parsing API Error:", err.response?.data || err.message);
        return { intent: 'UNKNOWN', category: '', description_summary: '' };
    }
}

// -----------------------------------------------------------------------------
// Google Apps Script state persistence helpers (simple storage layer)
async function getUserState(phone) {
    try {
        const resp = await axios.post(APPS_SCRIPT_URL, { action: 'GET_STATE', phone });
        if (typeof resp.data === 'string' && resp.data.startsWith('<!DOCTYPE')) {
            throw new Error("Apps Script returned HTML");
        }
        if (resp.data && resp.data.success && resp.data.user) {
            const user = resp.data.user;
            // ensure defaults
            user.preferred_persona = user.preferred_persona || 'bukky';
            user.city_initial = user.city_initial || 'Ibadan';
            user.state_initial = user.state_initial || 'Oyo';
            user.current_flow = user.current_flow || 'NEW';
            return user;
        } else {
            throw new Error("Apps Script returned unsuccessful response");
        }
    } catch (err) {
        console.error("APPS SCRIPT COMMUNICATION ERROR (GET_STATE):", err.message);
        // default user object (new user)
        return {
            phone,
            user_id: `NEW-${Date.now()}`,
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
            item_description: ''
        };
    }
}

async function saveUser(user) {
    try {
        // map fields for Apps Script
        user.item_name = user.service_category || user.item_name || '';
        user.item_description = user.description_summary || user.item_description || '';

        const resp = await axios.post(APPS_SCRIPT_URL, { action: 'SAVE_STATE', user });
        if (typeof resp.data === 'string' && resp.data.startsWith('<!DOCTYPE')) {
            console.error("APPS SCRIPT FAILURE (SAVE_STATE): Received HTML error page. State NOT saved.");
            return;
        }
        if (resp.data && resp.data.success) {
            console.log(`✅ User ${user.phone} state updated to: ${user.current_flow}`);
        } else {
            console.error("APPS SCRIPT FAILURE (SAVE_STATE): Unsuccessful or malformed response.", resp.data?.error || resp.data);
        }
    } catch (err) {
        console.error("APPS SCRIPT COMMUNICATION ERROR (SAVE_STATE):", err.message);
    }
}

// -----------------------------------------------------------------------------
// WhatsApp (Meta) helpers
const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

async function sendWhatsAppMessage(to, messagePayload) {
    try {
        const finalPayload = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...messagePayload
        };
        await axios.post(META_API_URL, finalPayload, {
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[Response Sent] To: ${to} | Type: ${messagePayload.type || 'text'}`);
    } catch (err) {
        console.error("Error sending message to WhatsApp:", err.response?.data || err.message);
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
                    { type: "reply", reply: { id: noId, title: "❌ NO, Start Over" } }
                ]
            },
            footer: { text: footerText || `Chatting with ${userPersona}` }
        }
    };
}

// -----------------------------------------------------------------------------
// Main interactive menu
async function sendMainMenu(senderId, user, senderName, isFirstTime = false) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()] || PERSONAS.BUKKY;
    const bodyText = isFirstTime
        ? `Hey *${senderName || 'there'}*! I'm ${persona.name}, your plug for buying, selling, and hiring services in Lagos and Oyo State. What's the plan?`
        : `I'm ready when you are, *${senderName || 'friend'}*! What's next on the agenda?`;

    const listRows = [
        { id: "OPT_FIND_SERVICE", title: "🛠️ Request a Service" },
        { id: "OPT_BUY_ITEM", title: "🛍️ Find an Item" },
        { id: "OPT_MY_ACTIVE", title: "💼 Ongoing Transactions" },
        { id: "OPT_REPORT_ISSUE", title: "🚨 Report an Issue" }
    ];
    if (user.role === 'unassigned') {
        listRows.push({ id: "OPT_REGISTER_ME", title: "🌟 Become a Provider" });
    }
    const otherPersonaName = persona.name === 'Bukky' ? 'Kore' : 'Bukky';
    const listSections = [
        { title: "Quick Actions", rows: listRows.map(r => ({ id: r.id, title: r.title })) },
        { title: "Settings", rows: [{ id: "OPT_SUPPORT", title: "⚙️ Support/Help" }, { id: "OPT_CHANGE_PERSONA", title: `🔄 Switch to ${otherPersonaName}` }] }
    ];

    const menuPayload = {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: `${persona.name}'s Main Menu` },
            body: { text: bodyText },
            action: { button: "View Options", sections: listSections },
            footer: { text: "Use the list below for quick access to everything!" }
        }
    };

    await sendWhatsAppMessage(senderId, menuPayload);
}

// -----------------------------------------------------------------------------
// Flow helpers
async function promptForLocation(senderId, user, isServiceFlow, contextualPrompt) {
    // contextualPrompt is required and tailored to the selected menu option
    const persona = user.preferred_persona || 'bukky';
    const aiText = await generateAIResponse(contextualPrompt, persona);

    user.current_flow = isServiceFlow ? "AWAIT_SERVICE_LOCATION_CONFIRM" : "AWAIT_BUYER_LOCATION_CONFIRM";
    await saveUser(user);

    await sendWhatsAppMessage(senderId, getConfirmationButtons(
        aiText,
        "CONFIRM_LOCATION",
        "CORRECT_LOCATION",
        `Current location: ${user.city_initial}, ${user.state_initial}`,
        persona
    ));
}

// Small helper to toggle persona
function togglePersona(currentPersona) {
    const p = (currentPersona || 'bukky').toUpperCase();
    if (p === 'BUKKY') return 'kore';
    return 'bukky';
}

// -----------------------------------------------------------------------------
// Main message router
async function handleMessageFlow(senderId, senderName, message) {
    try {
        let user = await getUserState(senderId);
        const incomingText = message.text?.body || '';
        const interactiveId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || '';
        const interactiveTitle = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';

        const flowInput = interactiveId || incomingText.trim();
        const aiParsed = await getBasicIntentAndParse(flowInput);
        const intent = aiParsed.intent;

        console.log(`[Flow] From ${senderName || senderId} | Intent: ${intent} | Current Flow: ${user.current_flow}`);

        // 1) NEW user or MENU or greeting -> MAIN_MENU
        if (user.current_flow === 'NEW' || intent === 'MENU' || (user.current_flow === 'MAIN_MENU' && intent === 'GREETING')) {
            user.current_flow = 'MAIN_MENU';
            await saveUser(user);
            await sendMainMenu(senderId, user, senderName, user.current_flow === 'MAIN_MENU' && user.user_id?.startsWith('NEW-'));
            return;
        }

        // 2) MAIN_MENU option selection
        if (user.current_flow === 'MAIN_MENU' && typeof intent === 'string' && intent.startsWith('OPT_')) {
            // Request a service
            if (intent === 'OPT_FIND_SERVICE') {
                user.selected_option = 'SERVICE';
                await promptForLocation(senderId, user, true,
                    "Nice! Let’s get you the right service provider. First, confirm the location where you need the service.");
                return;
            }

            // Find an item
            if (intent === 'OPT_BUY_ITEM') {
                user.selected_option = 'ITEM';
                await promptForLocation(senderId, user, false,
                    "Got you! I’ll help you find the item. Before I search, can you confirm the location you need it delivered or inspected?");
                return;
            }

            // Switch persona
            if (intent === 'OPT_CHANGE_PERSONA') {
                const previous = user.preferred_persona || 'bukky';
                const newPersona = togglePersona(previous);
                user.preferred_persona = newPersona;
                await saveUser(user);
                const resp = await generateAIResponse(`Switching persona to ${newPersona}. Acknowledge briefly.`, newPersona);
                await sendTextMessage(senderId, resp);
                await sendMainMenu(senderId, user, senderName, false);
                return;
            }

            // Placeholder features (coming soon)
            if (['OPT_MY_ACTIVE','OPT_REPORT_ISSUE','OPT_REGISTER_ME','OPT_SUPPORT'].includes(intent)) {
                let summary = intent.replace('OPT_', '').replace('_', ' ');
                const prompt = `You selected ${summary}. Acknowledge the selection and say the feature is coming soon, then return to the main menu.`;
                const responseText = await generateAIResponse(prompt, user.preferred_persona);
                await sendTextMessage(senderId, responseText);
                await sendMainMenu(senderId, user, senderName, false);
                return;
            }
        }

        // 3) Location confirmation flows
        if (user.current_flow === 'AWAIT_SERVICE_LOCATION_CONFIRM' || user.current_flow === 'AWAIT_BUYER_LOCATION_CONFIRM') {
            // If user confirmed location via button
            if (interactiveId === 'CONFIRM_LOCATION') {
                // move to next logical step (e.g., ask for details)
                const isService = user.current_flow === 'AWAIT_SERVICE_LOCATION_CONFIRM';
                user.current_flow = isService ? 'AWAIT_SERVICE_DETAILS' : 'AWAIT_ITEM_DETAILS';
                await saveUser(user);

                const nextPrompt = isService
                    ? "Great — what service do you need? (e.g., plumber, electrician) Keep it short."
                    : "Great — what item are you looking for? (e.g., used iPhone 12) Keep it short.";

                const aiText = await generateAIResponse(nextPrompt, user.preferred_persona);
                await sendTextMessage(senderId, aiText);
                return;
            }

            // If user chose to correct location
            if (interactiveId === 'CORRECT_LOCATION') {
                user.current_flow = 'AWAIT_LOCATION_INPUT';
                await saveUser(user);
                const aiText = await generateAIResponse("Okay — please type the location you'd like me to use (City, State).", user.preferred_persona);
                await sendTextMessage(senderId, aiText);
                return;
            }

            // If user typed a new location while we were awaiting confirmation
            if (incomingText && user.current_flow === 'AWAIT_SERVICE_LOCATION_CONFIRM' || incomingText && user.current_flow === 'AWAIT_BUYER_LOCATION_CONFIRM') {
                // Assume incomingText is new location update; save and confirm
                user.city_initial = incomingText;
                user.state_initial = user.state_initial || 'Oyo';
                // After receiving, ask for confirmation of that location
                user.current_flow = 'AWAIT_SERVICE_LOCATION_CONFIRM'; // re-set to confirmation step
                await saveUser(user);
                const aiText = await generateAIResponse(`You said "${incomingText}". Confirm this location?`, user.preferred_persona);
                await sendWhatsAppMessage(senderId, getConfirmationButtons(
                    aiText,
                    "CONFIRM_LOCATION",
                    "CORRECT_LOCATION",
                    `Current location: ${user.city_initial}, ${user.state_initial}`,
                    user.preferred_persona
                ));
                return;
            }
        }

        // 4) After user provides service/item details
        if (user.current_flow === 'AWAIT_SERVICE_DETAILS' || user.current_flow === 'AWAIT_ITEM_DETAILS') {
            // treat incomingText as the brief description / category
            if (incomingText) {
                if (user.current_flow === 'AWAIT_SERVICE_DETAILS') {
                    user.service_category = incomingText;
                    user.description_summary = incomingText;
                    user.current_flow = 'AWAIT_BUDGET_OR_CONFIRM';
                } else {
                    user.item_name = incomingText;
                    user.description_summary = incomingText;
                    user.current_flow = 'AWAIT_BUDGET_OR_CONFIRM';
                }
                await saveUser(user);

                const confPrompt = `Got it. Confirm you want me to search for "${incomingText}" in ${user.city_initial}, ${user.state_initial}?`;
                await sendWhatsAppMessage(senderId, getConfirmationButtons(confPrompt, "CONFIRM_SEARCH", "CORRECT_SEARCH", `Searching in: ${user.city_initial}, ${user.state_initial}`, user.preferred_persona));
                return;
            } else {
                // fallback
                const fallback = await generateAIResponse("I didn't get that — please type a short phrase describing the service or item.", user.preferred_persona);
                await sendTextMessage(senderId, fallback);
                return;
            }
        }

        // 5) Confirm search / correct search handling
        if (interactiveId === 'CONFIRM_SEARCH') {
            // In a real app, here you'd call a matching/search function.
            // For now: acknowledge and state next steps (searching / connecting)
            const actionText = await generateAIResponse(`Searching for "${user.description_summary}" in ${user.city_initial}, ${user.state_initial}. I'll show results or contact providers shortly.`, user.preferred_persona);
            await sendTextMessage(senderId, actionText);
            // set a follow-up state
            user.current_flow = 'MAIN_MENU';
            await saveUser(user);
            await sendMainMenu(senderId, user, senderName, false);
            return;
        }

        if (interactiveId === 'CORRECT_SEARCH') {
            user.current_flow = 'AWAIT_SERVICE_DETAILS';
            await saveUser(user);
            const askAgain = await generateAIResponse("Okay — please tell me again what you need (short phrase).", user.preferred_persona);
            await sendTextMessage(senderId, askAgain);
            return;
        }

        // 6) Generic fallbacks: while in MAIN_MENU and user sends something unknown
        if (user.current_flow === 'MAIN_MENU') {
            // If user typed free text while in main menu
            if (incomingText) {
                const fallback = await generateAIResponse("I'm not sure how to handle that right now. Use the menu below to pick an option.", user.preferred_persona);
                await sendTextMessage(senderId, fallback);
                await sendMainMenu(senderId, user, senderName, false);
                return;
            }
        }

        // 7) If we reach here, unknown/unsupported input - reset to main menu politely
        const fallback = await generateAIResponse("Sorry, I couldn't understand that. Let's go back to the main menu.", user.preferred_persona);
        await sendTextMessage(senderId, fallback);
        user.current_flow = 'MAIN_MENU';
        await saveUser(user);
        await sendMainMenu(senderId, user, senderName, false);
        return;

    } catch (err) {
        console.error("❌ Critical error in handleMessageFlow:", err?.message || err);
        try {
            const user = await getUserState(senderId);
            user.current_flow = 'MAIN_MENU';
            await saveUser(user);
            await sendTextMessage(senderId, "Uh oh, something went wrong on my side! Resetting the conversation. Type MENU to start again.");
            await sendMainMenu(senderId, user, senderName, false);
        } catch (innerErr) {
            console.error("❌ Error during error-recovery:", innerErr?.message || innerErr);
        }
    }
}

// -----------------------------------------------------------------------------
// Express server & webhook endpoints
app.use(bodyParser.json());

// GET - webhook verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ WEBHOOK VERIFIED successfully!');
        return res.status(200).send(challenge);
    } else {
        console.error('❌ Webhook verification failed!');
        return res.sendStatus(403);
    }
});

// POST - webhook messages
app.post('/webhook', (req, res) => {
    const data = req.body;
    if (data && data.object === 'whatsapp_business_account') {
        try {
            (data.entry || []).forEach(entry => {
                (entry.changes || []).forEach(change => {
                    if (change.field === 'messages' && change.value?.messages) {
                        const message = change.value.messages[0];
                        const senderId = change.value.contacts?.[0]?.wa_id;
                        const senderName = change.value.contacts?.[0]?.profile?.name || '';

                        if (!senderId || !message) return;

                        // Log
                        const logText = message.text?.body || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || 'Interactive Click';
                        console.log(`\n--- YourHelpa: NEW MESSAGE RECEIVED ---`);
                        console.log(`From: ${senderName} (${senderId})`);
                        console.log(`Input: ${logText}`);

                        // fire-and-forget (we handle errors internally)
                        handleMessageFlow(senderId, senderName, message).catch(e => console.error("handleMessageFlow error:", e?.message || e));
                    }
                });
            });
        } catch (err) {
            console.error("Error processing incoming webhook payload:", err?.message || err);
        }
    }
    // Always respond 200 to Meta quickly
    res.sendStatus(200);
});

// Start server
app.listen(PORT, () => {
    console.log(`\nYourHelpa Server is listening on port ${PORT}`);
    console.log("✅ Clean server.js loaded - flows and async issues fixed.");
});
