// --- REQUIRED MODULES ---
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();

// =========================================================================
// CRITICAL CONFIGURATION
// =========================================================================

const PORT = process.env.PORT || 5000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // Google Apps Script URL
const OPENROUTER_KEY = process.env.OPENROUTER_KEY; // set to your OpenRouter key

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ Missing WhatsApp environment variables.");
    process.exit(1);
}

if (!APPS_SCRIPT_URL) {
    console.error("❌ Missing APPS_SCRIPT_URL environment variable.");
    process.exit(1);
}

if (!OPENROUTER_KEY) {
    console.error("❌ Missing OPENROUTER_KEY environment variable.");
    process.exit(1);
}

// =========================================================================
// PERSONAS
// =========================================================================
const PERSONAS = {
    BUKKY: {
        name: "Bukky",
        tone: "friendly, informal, clear, enthusiastic",
    },
    KORE: {
        name: "Kore",
        tone: "calm, casual, concise",
    }
};

// =========================================================================
// UTILITY FUNCTIONS
// =========================================================================
async function openRouterGenerate(prompt, persona = 'bukky') {
    try {
        const response = await axios.post(
            'https://api.openrouter.ai/v1/chat/completions',
            {
                model: "openassistant-7b",
                messages: [
                    { role: "system", content: `You are ${PERSONAS[persona.toUpperCase()].name}, a ${PERSONAS[persona.toUpperCase()].tone} AI helper for WhatsApp.` },
                    { role: "user", content: prompt }
                ],
                max_tokens: 250,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data.choices?.[0]?.message?.content || "Oops! Something went wrong.";
    } catch (e) {
        console.error("OpenRouter Error:", e.message);
        return "⚠️ AI error. Please try again later.";
    }
}

// =========================================================================
// USER STATE MANAGEMENT
// =========================================================================
async function getUserState(phone) {
    try {
        const res = await axios.post(APPS_SCRIPT_URL, { action: 'GET_STATE', phone });
        if (res.data.success && res.data.user) {
            const user = res.data.user;
            if (!user.preferred_persona) user.preferred_persona = 'bukky';
            if (!user.city_initial) user.city_initial = 'Ibadan';
            if (!user.state_initial) user.state_initial = 'Oyo';
            if (!user.current_flow) user.current_flow = 'NEW';
            return user;
        } else throw new Error("Apps Script returned unsuccessful response");
    } catch (e) {
        console.error("GET_STATE Error:", e.message);
        return {
            phone,
            user_id: `NEW-${Date.now()}`,
            current_flow: 'NEW',
            preferred_persona: 'bukky',
            city_initial: 'Ibadan',
            state_initial: 'Oyo'
        };
    }
}

async function saveUser(user) {
    try {
        const res = await axios.post(APPS_SCRIPT_URL, { action: 'SAVE_STATE', user });
        if (!res.data.success) console.error("SAVE_STATE Error:", res.data);
    } catch (e) {
        console.error("SAVE_STATE Error:", e.message);
    }
}

// =========================================================================
// WHATSAPP MESSAGING HELPERS
// =========================================================================
const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

async function sendWhatsAppMessage(to, payload) {
    try {
        await axios.post(META_API_URL, { messaging_product: "whatsapp", recipient_type: "individual", to, ...payload }, {
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error("WhatsApp send error:", e.response?.data || e.message);
    }
}

async function sendTextMessage(to, text) {
    if (!text) return;
    await sendWhatsAppMessage(to, { type: "text", text: { body: text } });
}

function getConfirmationButtons(bodyText, yesId, noId, footerText, persona = 'bukky') {
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
            footer: { text: footerText || `Chatting with ${PERSONAS[persona.toUpperCase()].name}` }
        }
    };
}

// =========================================================================
// MAIN MENU
// =========================================================================
const MENU_OPTIONS = {
    "OPT_FIND_SERVICE": { type: "SERVICE", prompt: "Nice! Let's get you the right service provider. First, confirm the location where you need the help." },
    "OPT_BUY_ITEM": { type: "ITEM", prompt: "Got it! Let's find the item. Please confirm the location you need it delivered or inspected." },
    "OPT_MY_ACTIVE": { type: "INFO", prompt: "This feature is coming soon." },
    "OPT_REPORT_ISSUE": { type: "INFO", prompt: "Feature coming soon, we'll keep you updated." },
    "OPT_REGISTER_ME": { type: "INFO", prompt: "Feature coming soon." },
    "OPT_SUPPORT": { type: "INFO", prompt: "Feature coming soon." },
    "OPT_CHANGE_PERSONA": { type: "INFO", prompt: "Persona switched!" }
};

async function sendMainMenu(senderId, user, senderName, isFirstTime = false) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()] || PERSONAS.BUKKY;
    const bodyText = isFirstTime 
        ? `Hey *${senderName}*! I'm ${persona.name}, your plug for buying, selling, and hiring services in Lagos and Oyo State. What's the plan?`
        : `Ready when you are, *${senderName}*! What's next?`;

    const rows = [
        { id: "OPT_FIND_SERVICE", title: "🛠️ Request a Service" },
        { id: "OPT_BUY_ITEM", title: "🛍️ Find an Item" },
        { id: "OPT_MY_ACTIVE", title: "💼 Ongoing Transactions" },
        { id: "OPT_REPORT_ISSUE", title: "🚨 Report an Issue" }
    ];

    if (user.role === 'unassigned') rows.push({ id: "OPT_REGISTER_ME", title: "🌟 Become a Provider" });

    const sections = [
        { title: "Quick Actions", rows },
        { title: "Settings", rows: [
            { id: "OPT_SUPPORT", title: "⚙️ Support/Help" },
            { id: "OPT_CHANGE_PERSONA", title: "🔄 Switch Persona" }
        ]}
    ];

    const menuPayload = {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: `${persona.name}'s Main Menu` },
            body: { text: bodyText },
            action: { button: "View Options", sections },
            footer: { text: "Use the list below for quick access." }
        }
    };

    await sendWhatsAppMessage(senderId, menuPayload);
}

// =========================================================================
// FLOW HANDLER
// =========================================================================
async function handleMessageFlow(senderId, senderName, message) {
    let user = await getUserState(senderId);
    let interactiveId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || '';
    let textInput = message.text?.body?.trim() || '';

    // --- Determine flow input ---
    const flowInput = interactiveId || textInput;

    // --- NEW or MENU command ---
    if (user.current_flow === 'NEW' || flowInput.toUpperCase() === 'MENU') {
        user.current_flow = 'MAIN_MENU';
        await saveUser(user);
        await sendMainMenu(senderId, user, senderName, user.current_flow === 'NEW');
        return;
    }

    // --- MAIN_MENU OPTION ---
    if (user.current_flow === 'MAIN_MENU' && interactiveId) {
        const option = MENU_OPTIONS[interactiveId];
        if (!option) return; // unknown button

        user.selected_option = interactiveId;

        if (option.type === 'SERVICE') user.current_flow = 'AWAIT_SERVICE_LOCATION_CONFIRM';
        if (option.type === 'ITEM') user.current_flow = 'AWAIT_ITEM_LOCATION_CONFIRM';
        if (option.type === 'INFO') user.current_flow = 'MAIN_MENU'; // Info options stay in MAIN_MENU

        await saveUser(user);

        const aiText = await openRouterGenerate(option.prompt, user.preferred_persona);

        if (option.type === 'INFO') {
            await sendTextMessage(senderId, aiText);
            await sendMainMenu(senderId, user, senderName, false);
        } else {
            await sendWhatsAppMessage(senderId, getConfirmationButtons(
                aiText,
                "CONFIRM_LOCATION",
                "CORRECT_LOCATION",
                `Current location: ${user.city_initial}, ${user.state_initial}`,
                user.preferred_persona
            ));
        }
        return;
    }

    // --- LOCATION CONFIRMATION ---
    if (user.current_flow === 'AWAIT_SERVICE_LOCATION_CONFIRM' || user.current_flow === 'AWAIT_ITEM_LOCATION_CONFIRM') {
        if (interactiveId === 'CONFIRM_LOCATION') {
            await sendTextMessage(senderId, "✅ Got it! Moving to the next step.");
            user.current_flow = 'SERVICE_FLOW';
            await saveUser(user);
            return;
        }
        if (interactiveId === 'CORRECT_LOCATION') {
            await sendTextMessage(senderId, "No worries! Please send your correct location.");
            return;
        }
    }

    // --- FALLBACK ---
    await sendTextMessage(senderId, "I didn't understand that. Please select an option from the menu.");
}

// =========================================================================
// EXPRESS SETUP
// =========================================================================
app.use(bodyParser.json());

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
    else res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
    const data = req.body;
    if (data.object === 'whatsapp_business_account') {
        data.entry.forEach(entry => {
            entry.changes.forEach(change => {
                if (change.field === 'messages' && change.value.messages) {
                    const message = change.value.messages[0];
                    const senderId = change.value.contacts[0].wa_id;
                    const senderName = change.value.contacts[0].profile.name;
                    handleMessageFlow(senderId, senderName, message);
                }
            });
        });
    }
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`YourHelpa Server listening on port ${PORT}`);
});
