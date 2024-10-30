import "dotenv/config"
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants"
import { typing, recording } from "./utils/presence"
import fs from "fs";
import path from "path";
import OpenAI from "openai";
const openai = new OpenAI();
const speechFile = path.resolve("./assets/audio_bot/speech.mp3");

/** Port on which the server will run */
const PORT = process.env.PORT ?? 3008
/** OpenAI Assistant ID */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? ''
const userQueues = new Map();
const userLocks = new Map(); // New lock mechanism to prevent concurrent processing

/**
 * Function to process the user's message by sending it to the OpenAI API
 * and sending the response back to the user.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider); // Indicate typing status
    const response = await toAsk(ASSISTANT_ID, ctx.body, state); // Get response from OpenAI

    // Split the response into chunks and send them sequentially
    const chunks = response.split(/\n\n+/);
    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, ""); // Clean the chunk
        await flowDynamic([{ body: cleanedChunk }]); // Send cleaned chunk to the user
    }
};

/**
 * Function to handle the queue for each user.
 */
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    
    if (userLocks.get(userId)) {
        return; // If locked, skip processing
    }

    while (queue.length > 0) {
        userLocks.set(userId, true); // Lock the queue to prevent concurrent access
        const { ctx, flowDynamic, state, provider } = queue.shift(); // Get the next message in the queue
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider }); // Process the user's message
        } catch (error) {
            console.error(`Error processing message for user ${userId}:`, error); // Log any errors
        } finally {
            userLocks.set(userId, false); // Release the lock after processing
        }
    }

    userLocks.delete(userId); // Remove the lock once all messages are processed
    userQueues.delete(userId); // Remove the queue once all messages are processed
};

async function transcribeAudio(localPath) {
    return openai.audio.transcriptions.create({
        file: fs.createReadStream(localPath), // Read the audio file
        model: "whisper-1", // Specify the transcription model
    });
}

async function generateSpeech(cleanResponse) {
    const mp3 = await openai.audio.speech.create({
        model: "tts-1", // Specify the text-to-speech model
        voice: "alloy", // Specify the voice to use
        input: cleanResponse, // Input text for speech generation
    });
    const buffer = Buffer.from(await mp3.arrayBuffer()); // Convert response to buffer
    await fs.promises.writeFile(speechFile, buffer); // Save the generated speech to a file
}

async function deleteFile(filePath) {
    fs.unlink(filePath, (err) => {
        if (err) {
            console.error(`Error deleting file: ${filePath}`, err); // Log error if deletion fails
        } else {
            console.log(`File successfully deleted: ${filePath}`); // Log success message
        }
    });
}

export const voiceNoteFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.VOICE_NOTE)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        try {
            const localPath = await provider.saveFile(ctx, {
                path: "./assets/audio/", // Save the audio file to this path
            });
            const transcription = await transcribeAudio(localPath); // Transcribe the audio
            console.log("Transcription:", transcription.text); // Log the transcription
            await typing(ctx, provider); // Indicate typing status
            const response = await toAsk(ASSISTANT_ID, transcription.text, state); // Get response from OpenAI
            const chunks = response.split(/(?<!\d)\.\s+/g); // Split response into chunks
            for (const chunk of chunks) {
                await flowDynamic([{ body: chunk.trim().replace(/【.*?】/g, "") }]); // Send each chunk to the user
            }
            const cleanResponse = response.replace(/【.*?】/g, ""); // Clean the response
            await generateSpeech(cleanResponse); // Generate speech from the cleaned response
            console.log(speechFile); // Log the path to the speech file
            await recording(ctx, provider); // Indicate recording status
            await deleteFile(localPath); // Delete the original audio file
        } catch (error) {
            console.error("Error processing audio:", error); // Log any errors
        }
    })
    .addAnswer(" ", {media: speechFile}) // Send the generated speech as a response
    .addAction(async (ctx) => {
        await deleteFile(speechFile) // Delete the speech file after use
    })

const welcomeFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from; // Use the user's ID to create a unique queue for each user

        if (!userQueues.has(userId)) {
            userQueues.set(userId, []); // Initialize the queue for the user if it doesn't exist
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider }); // Add the current message to the user's queue

        // If this is the only message in the queue, process it immediately
        if (!userLocks.get(userId) && queue.length === 1) {
            await handleQueue(userId); // Start processing the queue
        }
    });

const main = async () => {
    const adapterFlow = createFlow([welcomeFlow, voiceNoteFlow]); // Create the flow with welcome and voice note flows

    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: true, // Ignore group messages
        readStatus: false, // Disable read status
    });

    const adapterDB = new MemoryDB(); // Initialize in-memory database

    const { httpServer } = await createBot({
        flow: adapterFlow, // Set the flow for the bot
        provider: adapterProvider, // Set the provider for the bot
        database: adapterDB, // Set the database for the bot
    });

    httpInject(adapterProvider.server); // Inject HTTP server for the provider
    httpServer(+PORT); // Start the HTTP server on the specified port
};

main(); // Execute the main function
