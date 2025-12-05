import { NextResponse } from 'next/server';
import { GoogleGenAI, GenerateContentParameters, Part } from '@google/genai';

// ---------------------------------------------------
// CORS CONFIG
// ---------------------------------------------------
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
    return NextResponse.json({}, { status: 200, headers: corsHeaders });
}

// ---------------------------------------------------
// Model Setup and Prompt Template
// ---------------------------------------------------

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set.");
}
const ai = new GoogleGenAI({ apiKey });

function buildPrompt(temp: number, humidity: number): string {
    return (
        "คุณคือระบบวิเคราะห์ภาพรองเท้าและแนะนำเวลาการเป่าแห้ง โดยต้องพิจารณาทั้งรูปภาพรองเท้า " +
        "รวมถึงข้อมูลความชื้นและอุณหภูมิที่ผู้ใช้ส่งมาให้ด้วย โปรดให้คำตอบในรูปแบบ JSON Object เท่านั้น\n\n" +

        `ความชื้นปัจจุบัน (humidity): ${humidity}%\n` +
        `อุณหภูมิ (temperature): ${temp}°C\n\n` +

        "หลักการคำนวณ:\n" +
        "• รองเท้าประเภทเดียวกันอาจมีเวลามาตรฐาน เช่น Sneakers เฉลี่ย 30 นาที\n" +
        "• หากความชื้นสูง (เช่น >70%) ให้เพิ่มเวลาอบตามความเหมาะสม\n" +
        "• แต่เวลาอบรวมต้องไม่เกิน 60 นาที\n" +
        "• ตู้อบ: ใช้พัดลมความร้อน 40–55°C\n\n" +

        "รูปแบบ Output:\n" +
        "1. 'shoe_type': ประเภทของรองเท้า พร้อมคำอธิบายสั้นๆ\n" +
        "2. 'recommended_time_minutes': เวลาที่แนะนำ (ตัวเลข นาที ไม่เกิน 60)\n\n" +

        "**สำคัญ: ให้ตอบเป็น JSON Object เท่านั้น ไม่มีข้อความอื่นเพิ่มเติม**\n" +
        "ตัวอย่าง Output:\n" +
        "{\"shoe_type\": \"รองเท้าผ้าใบ (Sneakers)\", \"recommended_time_minutes\": 40}"
    );
}

async function fileToGenerativePart(file: File): Promise<Part> {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return {
        inlineData: {
            data: buffer.toString("base64"),
            mimeType: file.type || 'image/jpeg',
        },
    };
}

// ---------------------------------------------------
// Main Route Handler
// ---------------------------------------------------

export async function POST(request: Request) {
    let imageFile: File | undefined;

    try {
        const formData = await request.formData();

        // Extract uploaded image file
        const fileEntry = formData.get('file');
        if (!fileEntry || typeof fileEntry === 'string' || !(fileEntry instanceof File)) {
            return NextResponse.json(
                { error: 'Invalid or missing file upload (expecting field name "file").' },
                { status: 400, headers: corsHeaders }
            );
        }
        imageFile = fileEntry;

        if (!imageFile.size) {
            return NextResponse.json(
                { error: 'Uploaded file is empty.' },
                { status: 400, headers: corsHeaders }
            );
        }

        // Extract humidity and temperature 
        const humidityRaw = formData.get("humidity");
        const tempRaw = formData.get("temperature");

        const humidity = humidityRaw ? Number(humidityRaw) : undefined;
        const temperature = tempRaw ? Number(tempRaw) : undefined;

        if (
            humidity === undefined ||
            temperature === undefined ||
            isNaN(humidity) ||
            isNaN(temperature)
        ) {
            return NextResponse.json(
                { error: "Missing or invalid humidity/temperature. Both must be numeric." },
                { status: 400, headers: corsHeaders }
            );
        }

        const imagePart = await fileToGenerativePart(imageFile);

        // Build dynamic prompt
        const prompt = buildPrompt(temperature, humidity);

        const contents: GenerateContentParameters['contents'] = [
            { role: "user", parts: [{ text: prompt }, imagePart] }
        ];

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: contents,
        });

        const candidate = response.candidates?.[0];
        const generatedText = candidate?.content?.parts?.[0]?.text;

        if (generatedText) {

            let analysisObject: { shoe_type: string; recommended_time_minutes: number };

            try {
                const cleanedText = generatedText.trim()
                    .replace(/^```json\s*/, '')
                    .replace(/\s*```$/, '');

                analysisObject = JSON.parse(cleanedText);

                if (!analysisObject.shoe_type || typeof analysisObject.recommended_time_minutes !== 'number') {
                    throw new Error("Parsed JSON object is missing required fields or has incorrect type.");
                }

            } catch (parseError) {
                console.error("JSON Parsing Failed:", parseError);

                return NextResponse.json(
                    {
                        error: "Analysis succeeded but the JSON response from Gemini could not be parsed.",
                        gemini_raw_output: generatedText,
                    },
                    { status: 500, headers: corsHeaders }
                );
            }

            return NextResponse.json(
                {
                    filename: imageFile.name,
                    filesize: imageFile.size,
                    shoe_type: analysisObject.shoe_type,
                    recommended_time_minutes: analysisObject.recommended_time_minutes,
                    temperature,
                    humidity,
                    model_used: "gemini-2.5-flash",
                },
                { headers: corsHeaders }
            );
        }

        const feedback = response.promptFeedback;
        if (feedback && feedback.blockReason) {
            return NextResponse.json(
                {
                    error: `Content blocked due to safety settings: ${feedback.blockReason}`,
                    safety_ratings: feedback.safetyRatings
                },
                { status: 403, headers: corsHeaders }
            );
        }

        console.error("Gemini failed to generate content:", response);
        return NextResponse.json(
            {
                error: 'Gemini did not return valid text. See debug info.',
                full_response_debug: response
            },
            { status: 500, headers: corsHeaders }
        );

    } catch (error) {
        console.error("Global Catch Error:", error);

        return NextResponse.json(
            {
                error: 'Internal server error occurred while processing your request.',
                details: error instanceof Error ? error.message : 'Unknown error.'
            },
            { status: 500, headers: corsHeaders }
        );
    }
}
