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

// --- OPENROUTER CONFIGURATION ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "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";
const OPENROUTER_MODEL = "gpt-4o-mini"; // or any supported OpenRouter model

// --- GOOGLE APPS SCRIPT CONFIGURATION ---
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ CRITICAL ERROR: WhatsApp environment variables missing.");
    process.exit(1);
}

if (!APPS_SCRIPT_URL) {
    console.error("❌ CRITICAL ERROR: APPS_SCRIPT_URL is missing.");
    process.exit(1);
}

// =========================================================================
// PERSONA & SYSTEM PROMPT CONFIGURATION
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

function getSystemInstruction(personaName) {
    const persona = PERSONAS[personaName.toUpperCase()] || PERSONAS.BUKKY;

    return `
You are ${persona.name}, a friendly WhatsApp-based AI helping users buy, sell, and hire services in Lagos and Oyo State.
Persona tone: ${persona.tone}

Rules:
1. Informal, conversational, 1-3 short sentences max.
2. Action-oriented: guide the user to the next step.
3. Nigerian context: mention Lagos or Oyo naturally.
4. If a feature is unavailable, say "coming soon" and redirect to main options.
`;
}

// =========================================================================
// OPENROUTER AI FUNCTIONS
// =========================================================================

async function openRouterGenerate(prompt, persona = "bukky") {
    try {
        const systemPrompt = getSystemInstruction(persona);
        const payload = {
            model: OPENROUTER_MODEL,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            max_tokens: 300
        };

        const response = await axios.post(
            "https://api.openrouter.ai/v1/chat/completions",
            payload,
            {
                headers: {
                    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        return response.data.choices?.[0]?.message?.content || "I’m having trouble responding. Please type MENU.";
    } catch (err) {
        console.error("OpenRouter API Error:", err.response?.data || err.message);
        return "I am experiencing network issues. Try again in a moment.";
    }
}

/**
 * Basic intent parsing using OpenRouter
 */
async function parseUserIntent(input) {
    // Quick prefix handling for buttons or menu
    const knownPrefix = ['OPT_', 'CONFIRM_', 'CORRECT_', 'SELECT_'].find(p => input.startsWith(p));
    if (knownPrefix) return { intent: input, category: '', description_summary: '' };
    if (input.toUpperCase() === "MENU" || input.toUpperCase() === "BACK") return { intent: "MENU", category: '', description_summary: '' };

    const prompt = `
Parse the user message: "${input}".
Return JSON with keys: intent (GREETING, SERVICE_REQUEST, PRODUCT_REQUEST, MENU, UNKNOWN), category (optional), description_summary (optional).
Respond ONLY as JSON.
`;

    const raw = await openRouterGenerate(prompt);
    try {
        return JSON.parse(raw);
    } catch {
        return { intent: "UNKNOWN", category: '', description_summary: '' };
    }
}

// =========================================================================
// GOOGLE APPS SCRIPT STATE MANAGEMENT
// =========================================================================

async function getUserState(phone) {
    try {
        const resp = await axios.post(APPS_SCRIPT_URL, { action: "GET_STATE", phone });
        if (resp.data.success && resp.data.user) {
            const user = resp.data.user;
            user.preferred_persona ||= "bukky";
            user.city_initial ||= "Ibadan";
            user.state_initial ||= "Oyo";
            user.current_flow ||= "NEW";
            return user;
        }
        throw new Error("Apps Script unsuccessful response");
    } catch (e) {
        console.error("Apps Script GET_STATE error:", e.message);
        return {
            phone, user_id: `NEW-${Date.now()}`, role: "unassigned", name: "",
            city: "Ibadan", state_initial: "Oyo", current_flow: "NEW",
            preferred_persona: "bukky", row_index: 0,
            service_category: "", description_summary: "", city_initial: "Ibadan",
            budget_initial: "", item_name: "", item_description: ""
        };
    }
}

async function saveUser(user) {
    try {
        user.item_name = user.service_category;
        user.item_description = user.description_summary;
        const resp = await axios.post(APPS_SCRIPT_URL, { action: "SAVE_STATE", user });
        if (!resp.data.success) console.error("Apps Script SAVE_STATE failed:", resp.data);
    } catch (e) {
        console.error("Apps Script SAVE_STATE error:", e.message);
    }
}

// =========================================================================
// WHATSAPP MESSAGING HELPERS
// =========================================================================

const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

async function sendWhatsAppMessage(to, payload) {
    try {
        await axios.post(META_API_URL, { messaging_product: "whatsapp", recipient_type: "individual", to, ...payload }, {
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" }
        });
    } catch (err) {
        console.error("WhatsApp send message error:", err.response?.data || err.message);
    }
}

async function sendTextMessage(to, text) {
    if (!text) return;
    await sendWhatsAppMessage(to, { type: "text", text: { body: text } });
}

function getConfirmationButtons(bodyText, yesId, noId, footerText, persona = "bukky") {
    return {
        type: "interactive",
        interactive: {
            type: "button",
            body: { text: bodyText },
            action: { buttons: [{ type: "reply", reply: { id: yesId, title: "✅ YES" } }, { type: "reply", reply: { id: noId, title: "❌ NO" } }] },
            footer: { text: footerText || `Chatting with ${persona}` }
        }
    };
}

async function sendMainMenu(senderId, user, senderName, isFirstTime = false) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()] || PERSONAS.BUKKY;
    const bodyText = isFirstTime
        ? `Hey *${senderName}*! I'm ${persona.name}, your plug for buying, selling, and hiring services in Lagos and Oyo State. What's the plan?`
        : `I'm ready when you are, *${senderName}*! What's next?`;

    const listRows = [
        { id: "OPT_FIND_SERVICE", title: "🛠️ Request a Service" },
        { id: "OPT_BUY_ITEM", title: "🛍️ Find an Item" },
        { id: "OPT_MY_ACTIVE", title: "💼 Ongoing Transactions" },
        { id: "OPT_REPORT_ISSUE", title: "🚨 Report an Issue" }
    ];

    if (user.role === "unassigned") listRows.push({ id: "OPT_REGISTER_ME", title: "🌟 Become a Provider" });
    const otherPersona = persona.name === "Bukky" ? "Kore" : "Bukky";

    const sections = [
        { title: "Quick Actions", rows: listRows.map(r => ({ id: r.id, title: r.title })) },
        { title: "Settings", rows: [{ id: "OPT_SUPPORT", title: "⚙️ Support/Help" }, { id: "OPT_CHANGE_PERSONA", title: `🔄 Switch to ${otherPersona}` }] }
    ];

    const menuPayload = {
        type: "interactive",
        interactive: { type: "list", header: { type: "text", text: `${persona.name}'s Main Menu` }, body: { text: bodyText }, action: { button: "View Options", sections }, footer: { text: "Use the list below!" } }
    };

    await sendWhatsAppMessage(senderId, menuPayload);
}

async function promptForLocation(senderId, user, isServiceFlow, promptText) {
    const text = await openRouterGenerate(promptText, user.preferred_persona);
    user.current_flow = isServiceFlow ? "AWAIT_SERVICE_LOCATION_CONFIRM" : "AWAIT_BUYER_LOCATION_CONFIRM";
    await saveUser(user);

    await sendWhatsAppMessage(senderId, getConfirmationButtons(text, "CONFIRM_LOCATION", "CORRECT_LOCATION", `Current: ${user.city_initial}, ${user.state_initial}`, user.preferred_persona));
}

// =========================================================================
// MAIN MESSAGE HANDLER
// =========================================================================

async function handleMessageFlow(senderId, senderName, message) {
    try {
        let user = await getUserState(senderId);
        let incomingText = message.text?.body || "";
        let interactiveId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || "";
        const flowInput = interactiveId || incomingText.trim();

        const aiParsed = await parseUserIntent(flowInput);
        const intent = aiParsed.intent;
        console.log(`[Flow] ${senderName} | Intent: ${intent} | Current Flow: ${user.current_flow}`);

        // --- NEW USER / GREETING / MENU ---
        if (user.current_flow === "NEW" || intent === "MENU" || (user.current_flow === "MAIN_MENU" && intent === "GREETING")) {
            const isFirstTime = user.current_flow === "NEW";
            user.current_flow = "MAIN_MENU";
            await saveUser(user);
            await sendMainMenu(senderId, user, senderName, isFirstTime);
            return;
        }

        // --- MAIN MENU SELECTION ---
        if (user.current_flow === "MAIN_MENU" && intent.startsWith("OPT_")) {
            if (intent === "OPT_FIND_SERVICE") {
                await promptForLocation(senderId, user, true, "Nice! Let's get you the right service provider. Confirm the location first.");
                return;
            }
            if (intent === "OPT_BUY_ITEM") {
                await promptForLocation(senderId, user, false, "Got you! I’ll help you find the item. Confirm the location first.");
                return;
            }

            // Non-flow options
            const promptText = `You selected ${intent.replace("OPT_", "")}. Acknowledge and mention coming soon or confirm persona switch.`;
            const responseText = await openRouterGenerate(promptText, user.preferred_persona);
            await sendTextMessage(senderId, responseText);
            await sendMainMenu(senderId, user, senderName, false);
            return;
        }

        // --- FALLBACK ---
        const fallback = await openRouterGenerate("I'm not sure how to handle that. Suggest MENU options.", user.preferred_persona);
        await sendTextMessage(senderId, fallback);
        await sendMainMenu(senderId, user, senderName, false);

    } catch (err) {
        console.error("Critical flow error:", err.message);
        let user = await getUserState(senderId);
        await sendTextMessage(senderId, "Oops! Something went wrong. Type MENU to start again.");
        user.current_flow = "MAIN_MENU";
        await saveUser(user);
    }
}

// =========================================================================
// EXPRESS SERVER SETUP
// =========================================================================

app.use(bodyParser.json());

app.get("/webhook", (req, res) => {
    const { mode, hub_verify_token, hub_challenge } = req.query;
    if (mode === "subscribe" && hub_verify_token === VERIFY_TOKEN) {
        console.log("✅ Webhook verified!");
        res.status(200).send(hub_challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post("/webhook", (req, res) => {
    const data = req.body;
    if (data.object === "whatsapp_business_account") {
        data.entry.forEach(entry => {
            entry.changes.forEach(change => {
                if (change.field === "messages" && change.value.messages) {
                    const message = change.value.messages[0];
                    const senderId = change.value.contacts[0].wa_id;
                    const senderName = change.value.contacts[0].profile.name;
                    if (message.type === "text" || message.type === "interactive") {
                        handleMessageFlow(senderId, senderName, message);
                    }
                }
            });
        });
    }
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`\nYourHelpa Server listening on port ${PORT}`);
});
