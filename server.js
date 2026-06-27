require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(bodyParser.json());
const prisma = new PrismaClient();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const sendMessage = async (chatId, text) => {
    try {
        await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
            chat_id: chatId,
            text: text
        });
    } catch (error) {
        console.error("Error sending message:", error?.response?.data || error.message);
    }
};

app.post('/webhook/telegram', async (req, res) => {
    const message = req.body.message;

    if (message && message.text) {
        const chatId = String(message.chat.id);
        const customerName = message.from?.first_name || "Unknown";
        const incomingText = message.text;

        console.log(`[New Message] ${customerName}: ${incomingText}`);

        try {
            await prisma.customer.upsert({
                where: { id: chatId },
                update: { name: customerName },
                create: { id: chatId, name: customerName, platform: "telegram" }
            });

            if (incomingText.toLowerCase() === "/start" || incomingText.toLowerCase() === "/reset") {
                await prisma.conversation.updateMany({
                    where: { customerId: chatId, status: "assigned_to_human" },
                    data: { status: "assigned_to_bot" }
                });
                await sendMessage(chatId, "Hello! I am back. How can I help you?");
                return res.sendStatus(200);
            }

            let conversation = await prisma.conversation.findFirst({
                where: { customerId: chatId },
                orderBy: { createdAt: 'desc' }
            });

            if (!conversation) {
                conversation = await prisma.conversation.create({
                    data: { customerId: chatId, status: "assigned_to_bot" }
                });
            }

            await prisma.message.create({
                data: {
                    conversationId: conversation.id,
                    sender: "customer",
                    text: incomingText
                }
            });

            if (conversation.status === "assigned_to_bot") {
                console.log("Processing request via Gemini...");

                const knowledgeItems = await prisma.knowledgeBase.findMany();
                const formattedKB = knowledgeItems.map(item => `Q: ${item.question}\nA: ${item.answer}`).join("\n\n");

                const systemInstruction = `You are a helpful customer support assistant.
You have access to a Knowledge Base. Use ONLY the facts listed in the Knowledge Base to answer the user's query.

Knowledge Base:
${formattedKB || "No information available."}

Rules:
1. If the user is just saying hello or greeting you, reply with a polite greeting and ask how you can help.
2. If the user's query can be answered using the facts in the Knowledge Base, reply with the answer politely and concisely. Do not hallucinate or use any external knowledge.
3. If the user's query CANNOT be answered using the Knowledge Base and is not a simple greeting, reply EXACTLY with the token "[HANDOFF]" (without any other text).`;

                const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
                const prompt = `${systemInstruction}\n\nUser query: "${incomingText}"`;

                const result = await model.generateContent(prompt);
                const botReply = result.response.text().trim();

                if (botReply === "[HANDOFF]" || botReply.includes("[HANDOFF]")) {
                    console.log(`[Handoff Triggered] Handing conversation ${conversation.id} over to human agent.`);

                    await prisma.conversation.update({
                        where: { id: conversation.id },
                        data: { status: "assigned_to_human" }
                    });

                    const handoffMessage = "Connecting you to a customer care executive. Please wait, a human agent will assist you shortly.";
                    await sendMessage(chatId, handoffMessage);

                    await prisma.message.create({
                        data: {
                            conversationId: conversation.id,
                            sender: "bot",
                            text: handoffMessage
                        }
                    });
                } else {
                    await sendMessage(chatId, botReply);

                    await prisma.message.create({
                        data: {
                            conversationId: conversation.id,
                            sender: "bot",
                            text: botReply
                        }
                    });

                    console.log(`[Gemini Reply]: ${botReply}`);
                }
            } else {
                console.log(`Message routed to Human Agent (Dashboard). Customer ID: ${chatId}`);
            }
        } catch (error) {
            console.error("Error Processing Request:", error);
            await sendMessage(chatId, "Sorry, I am currently unable to process your request. Please try again later.");
        }
    }

    res.sendStatus(200);
});

app.get('/api/conversations/pending', async (req, res) => {
    try {
        const pendingChats = await prisma.conversation.findMany({
            where: { status: "assigned_to_human" },
            include: {
                messages: { orderBy: { createdAt: 'asc' } },
                customer: true
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(pendingChats);
    } catch (error) {
        console.error("Error fetching chats:", error);
        res.status(500).json({ error: "Failed to fetch conversations" });
    }
});

app.post('/api/admin/reply', async (req, res) => {
    const { conversationId, text } = req.body;

    if (!conversationId || !text) {
        return res.status(400).json({ error: "conversationId and text are required" });
    }

    try {
        const conversation = await prisma.conversation.findUnique({
            where: { id: conversationId },
            include: { customer: true }
        });

        if (!conversation) {
            return res.status(404).json({ error: "Conversation not found" });
        }

        await sendMessage(conversation.customerId, `Support Team: ${text}`);

        await prisma.message.create({
            data: {
                conversationId: conversation.id,
                sender: "human_agent",
                text: text
            }
        });

        res.json({ success: true, message: "Reply sent successfully" });
    } catch (error) {
        console.error("Error sending admin reply:", error);
        res.status(500).json({ error: "Failed to send reply" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});