// --- REQUIRED MODULES ---
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();

// =========================================================================
// CONFIGURATION
// =========================================================================

const PORT = process.env.PORT || 5000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// OpenRouter API Key
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "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";

// Google Apps Script backend
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID || !APPS_SCRIPT_URL) {
    console.error("❌ Missing critical environment variables. Exiting.");
    process.exit(1);
}

// =========================================================================
// PERSONAS
// =========================================================================
const PERSONAS = {
    BUKKY: {
        name: "Bukky",
        tone: "super friendly, enthusiastic, and uses clear, informal language. She's your helpful marketplace buddy.",
    },
    KORE: {
        name: "Kore",
        tone: "calm, cool, and provides concise, easy-to-understand guidance with an informal vibe. He's efficient but casual.",
    }
};

// =========================================================================
// MENU OPTIONS (Dynamic Handling)
// =========================================================================
const MENU_OPTIONS = {
    OPT_FIND_SERVICE: { type: 'SERVICE', prompt: "Nice! Let's get you the right service provider. First, confirm the location where you need the help." },
    OPT_BUY_ITEM: { type: 'ITEM', prompt: "Got you! I’ll help you find the item. Before I search, can you confirm the location you need it delivered or inspected?" },
    OPT_MY_ACTIVE: { type: 'INFO', prompt: "You selected 'Ongoing Transactions'. This feature is coming soon!" },
    OPT_REPORT_ISSUE: { type: 'INFO', prompt: "You selected 'Report an Issue'. This feature is coming soon!" },
    OPT_REGISTER_ME: { type: 'INFO', prompt: "You selected 'Become a Provider'. This feature is coming soon!" },
    OPT_SUPPORT: { type: 'INFO', prompt: "You selected 'Support/Help'. We'll get help for you soon!" },
    OPT_CHANGE_PERSONA: { type: 'INFO', prompt: "You switched your persona. Enjoy chatting with the new persona!" }
};

// =========================================================================
// HELPER FUNCTIONS
// =========================================================================

// OpenRouter AI Response
async function openRouterGenerate(prompt, persona = 'bukky') {
    try {
        const systemMessage = `You are ${PERSONAS[persona.toUpperCase()].name}, ${PERSONAS[persona.toUpperCase()].tone}. Keep messages friendly, concise, and action-oriented.`;
        const response = await axios.post(
            "https://api.openrouter.ai/v1/chat/completions",
            {
                model: "openrouter-gpt-3.5-turbo",
                messages: [
                    { role: "system", content: systemMessage },
                    { role: "user", content: prompt }
                ]
            },
            {
                headers: {
                    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );
        return response.data.choices?.[0]?.message?.content || "Oops, something went wrong!";
    } catch (e) {
        console.error("OpenRouter AI Error:", e.message);
        return "I'm having trouble generating a response. Please try again.";
    }
}

// WhatsApp API
const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

async function sendWhatsAppMessage(to, payload) {
    try {
        await axios.post(META_API_URL, { messaging_product: "whatsapp", recipient_type: "individual", to, ...payload }, {
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error("❌ WhatsApp Send Error:", e.response?.data || e.message);
    }
}

async function sendTextMessage(to, text) {
    if (!text) return;
    await sendWhatsAppMessage(to, { type: "text", text: { body: text } });
}

function getConfirmationButtons(bodyText, yesId, noId, footerText, persona='bukky') {
    return {
        type: "interactive",
        interactive: {
            type: "button",
            body: { text: bodyText },
            action: { buttons: [
                { type: "reply", reply: { id: yesId, title: "✅ YES, Confirm" } },
                { type: "reply", reply: { id: noId, title: "❌ NO, Start Over" } }
            ] },
            footer: { text: footerText || `Chatting with ${PERSONAS[persona.toUpperCase()].name}` }
        }
    };
}

// =========================================================================
// USER STATE MANAGEMENT
// =========================================================================
async function getUserState(phone) {
    try {
        const res = await axios.post(APPS_SCRIPT_URL, { action: "GET_STATE", phone });
        if (res.data.success && res.data.user) return res.data.user;
    } catch (e) {
        console.error("APPS SCRIPT GET_STATE ERROR:", e.message);
    }
    // Default new user
    return {
        phone, user_id: `NEW-${Date.now()}`, role: 'unassigned', name: '',
        city: 'Ibadan', state_initial: 'Oyo', current_flow: 'NEW', preferred_persona: 'bukky',
        service_category: '', description_summary: '', item_name: '', item_description: ''
    };
}

async function saveUser(user) {
    try {
        user.item_name = user.service_category;
        user.item_description = user.description_summary;
        const res = await axios.post(APPS_SCRIPT_URL, { action: "SAVE_STATE", user });
        if (!res.data.success) console.error("APPS SCRIPT SAVE_STATE FAILED:", res.data);
    } catch (e) {
        console.error("APPS SCRIPT SAVE_STATE ERROR:", e.message);
    }
}

// =========================================================================
// MENU & LOCATION PROMPT
// =========================================================================
async function sendMainMenu(senderId, user, senderName, isFirstTime=false) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()] || PERSONAS.BUKKY;
    const bodyText = isFirstTime
        ? `Hey ${senderName}! I'm ${persona.name}, your plug for buying, selling, and hiring services in Lagos and Oyo State. What's the plan?`
        : `I'm ready when you are, ${senderName}! What's next on the agenda?`;

    const listRows = [
        { id: "OPT_FIND_SERVICE", title: "🛠️ Request a Service" },
        { id: "OPT_BUY_ITEM", title: "🛍️ Find an Item" },
        { id: "OPT_MY_ACTIVE", title: "💼 Ongoing Transactions" },
        { id: "OPT_REPORT_ISSUE", title: "🚨 Report an Issue" },
    ];

    if (user.role === 'unassigned') listRows.push({ id: "OPT_REGISTER_ME", title: "🌟 Become a Provider" });

    const otherPersonaName = persona.name === 'Bukky' ? 'Kore' : 'Bukky';

    const menuPayload = {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: `${persona.name}'s Main Menu` },
            body: { text: bodyText },
            action: {
                button: "View Options",
                sections: [
                    { title: "Quick Actions", rows: listRows },
                    { title: "Settings", rows: [
                        { id: "OPT_SUPPORT", title: "⚙️ Support/Help" },
                        { id: "OPT_CHANGE_PERSONA", title: `🔄 Switch to ${otherPersonaName}` }
                    ]}
                ]
            },
            footer: { text: "Use the list below for quick access to everything!" }
        }
    };

    await sendWhatsAppMessage(senderId, menuPayload);
}

async function promptForLocation(senderId, user, isServiceFlow, contextualPrompt) {
    const aiText = await openRouterGenerate(contextualPrompt, user.preferred_persona);
    user.current_flow = isServiceFlow ? "AWAIT_SERVICE_LOCATION_CONFIRM" : "AWAIT_BUYER_LOCATION_CONFIRM";
    await saveUser(user);

    await sendWhatsAppMessage(senderId, getConfirmationButtons(
        aiText, "CONFIRM_LOCATION", "CORRECT_LOCATION",
        `Current location: ${user.city || user.city_initial}, ${user.state_initial}`,
        user.preferred_persona
    ));
}

// =========================================================================
// MESSAGE ROUTER
// =========================================================================
async function handleMessageFlow(senderId, senderName, message) {
    try {
        const user = await getUserState(senderId);
        const incomingText = message.text?.body || '';
        const interactiveId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || '';
        const flowInput = interactiveId || incomingText.trim();

        // NEW USER OR MENU COMMAND
        if (user.current_flow === 'NEW' || flowInput.toUpperCase() === 'MENU') {
            user.current_flow = 'MAIN_MENU';
            await saveUser(user);
            await sendMainMenu(senderId, user, senderName, user.current_flow === 'NEW');
            return;
        }

        // MENU OPTION CLICK HANDLING
        if (user.current_flow === "MAIN_MENU" && flowInput.startsWith("OPT_")) {
            const option = MENU_OPTIONS[flowInput];
            if (!option) {
                await sendTextMessage(senderId, "I didn't understand that. Please select from the menu.");
                await sendMainMenu(senderId, user, senderName, false);
                return;
            }

            if (option.type === 'SERVICE') {
                await promptForLocation(senderId, user, true, option.prompt);
                return;
            }

            if (option.type === 'ITEM') {
                await promptForLocation(senderId, user, false, option.prompt);
                return;
            }

            // INFO type
            const responseText = await openRouterGenerate(option.prompt, user.preferred_persona);
            await sendTextMessage(senderId, responseText);
            await sendMainMenu(senderId, user, senderName, false);
            return;
        }

        // FALLBACK
        await sendTextMessage(senderId, "Sorry, I didn't get that. Please select an option from the menu.");
        await sendMainMenu(senderId, user, senderName, false);

    } catch (e) {
        console.error("Critical handleMessageFlow error:", e.message);
        await sendTextMessage(senderId, "Oops! Something went wrong. Type MENU to restart.");
    }
}

// =========================================================================
// EXPRESS SERVER
// =========================================================================
app.use(bodyParser.json());

// Webhook verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log("✅ Webhook verified!");
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Webhook messages
app.post('/webhook', async (req, res) => {
    const data = req.body;
    if (data.object === 'whatsapp_business_account') {
        data.entry.forEach(entry => {
            entry.changes.forEach(change => {
                if (change.field === 'messages' && change.value.messages) {
                    const message = change.value.messages[0];
                    const senderId = change.value.contacts[0].wa_id;
                    const senderName = change.value.contacts[0].profile.name;

                    if (message.type === 'text' || message.type === 'interactive') {
                        handleMessageFlow(senderId, senderName, message);
                    }
                }
            });
        });
    }
    res.sendStatus(200);
});

// Start server
app.listen(PORT, () => {
    console.log(`YourHelpa Server listening on port ${PORT}`);
});
