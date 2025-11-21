import { NextResponse } from 'next/server';
import { GoogleGenAI, GenerateContentParameters, Part } from '@google/genai';

// ---------------------------------------------------
// 1. การตั้งค่าและ Prompt
// ---------------------------------------------------

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set.");
}
const ai = new GoogleGenAI({ apiKey });

// ⚠️ Prompt ที่ปรับปรุง: เน้นให้ Gemini ส่งคืน JSON โดยมีฟิลด์ที่กำหนด
const PROMPT: string = (
    "คุณคือระบบวิเคราะห์ภาพรองเท้าและแนะนำเวลาการเป่าแห้ง โปรดวิเคราะห์ภาพรองเท้าและให้ข้อมูลออกมาในรูปแบบ JSON Object เท่านั้น " +
    "โดยให้มีโครงสร้างดังนี้:\n" +
    "1. 'shoe_type': ประเภทของรองเท้าและคำอธิบายสั้นๆ (เช่น 'รองเท้าผ้าใบ (ประเภท Sneakers) ความหนาปานกลาง')\n" +
    "2. 'recommended_time_minutes': เวลาที่แนะนำในการเป่าแห้ง (เป็นตัวเลขหน่วยนาที ไม่เกิน 60)\n" +
    "เงื่อนไขการอบ: ตู้อบสาธารณะ, พัดลมความร้อน (40–55°C), ห้ามเกิน 60 นาที\n\n" +
    "**สำคัญ: Output ต้องเป็น JSON Object ที่ถูกต้องเท่านั้น ไม่มีข้อความอธิบายใด ๆ เพิ่มเติมก่อนหรือหลัง**\n" +
    "ตัวอย่าง Output:\n" +
    "{\"shoe_type\": \"รองเท้าผ้าใบ (ประเภท Sneakers) ความหนาปานกลาง\", \"recommended_time_minutes\": 40}"
);

// Helper function: แปลง File Object เป็น Gemini Part (เหมือนเดิม)
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
// 2. Route Handler หลัก (POST)
// ---------------------------------------------------

export async function POST(request: Request) {
    let imageFile: File | undefined; // ประกาศตัวแปรนี้ด้านนอกเพื่อให้เข้าถึงใน catch ได้
    
    try {
        const formData = await request.formData();
        const fileEntry = formData.get('file');

        if (!fileEntry || typeof fileEntry === 'string' || !(fileEntry instanceof File)) {
            return NextResponse.json({ error: 'Invalid or missing file upload (expecting field name "file").' }, { status: 400 });
        }
        
        imageFile = fileEntry;
        if (!imageFile.size) {
             return NextResponse.json({ error: 'Uploaded file is empty.' }, { status: 400 });
        }

        const imagePart = await fileToGenerativePart(imageFile);
        const contents: GenerateContentParameters['contents'] = [
            { role: "user", parts: [{ text: PROMPT }, imagePart] }
        ];

        // 4. เรียกใช้ Gemini API
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: contents,
        });

        // 5. การตรวจสอบผลลัพธ์
        const candidate = response.candidates?.[0];
        const generatedText = candidate?.content?.parts?.[0]?.text;

        if (generatedText) {
            
            // ***************************************************************
            // ⚠️ ขั้นตอนใหม่: การพยายาม Parse JSON String
            // ***************************************************************
            let analysisObject: { shoe_type: string; recommended_time_minutes: number };
            
            try {
                // ทำความสะอาดข้อความก่อน Parse (เช่น ลบเครื่องหมาย ```json ถ้ามี)
                const cleanedText = generatedText.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
                analysisObject = JSON.parse(cleanedText);

                // ตรวจสอบความถูกต้องของ Object
                if (!analysisObject.shoe_type || typeof analysisObject.recommended_time_minutes !== 'number') {
                     throw new Error("Parsed JSON object is missing required fields or has incorrect type.");
                }

            } catch (parseError) {
                console.error("JSON Parsing Failed:", parseError);
                // ส่งคืนข้อความดิบจาก Gemini และแจ้งเตือนปัญหา Parsing
                return NextResponse.json({
                    error: "Analysis successful but failed to parse JSON output from Gemini. Check prompt compliance.",
                    gemini_raw_output: generatedText,
                }, { status: 500 });
            }

            // สำเร็จ: ส่งคืนผลลัพธ์ในรูปแบบ JSON Structure ที่กำหนดเอง
            return NextResponse.json({
                filename: imageFile.name,
                filesize: imageFile.size,
                shoe_type: analysisObject.shoe_type,
                recommended_time_minutes: analysisObject.recommended_time_minutes,
                model_used: "gemini-2.5-flash",
            });
        } 
        
        // 6. การจัดการ Content Blocked/No Output (เหมือนเดิม)
        const feedback = response.promptFeedback;
        if (feedback && feedback.blockReason) {
            // ... (โค้ดจัดการ 403) ...
             return NextResponse.json({ 
                error: `Content was blocked due to safety settings: ${feedback.blockReason}`, 
                safety_ratings: feedback.safetyRatings
            }, { status: 403 });
        }

        console.error("Gemini failed to generate content:", response);
        return NextResponse.json({ 
            error: 'Gemini did not return any text output or the response structure was unexpected.',
            full_response_debug: response
        }, { status: 500 });

    } catch (error) {
        console.error("Global Catch Error:", error);
        return NextResponse.json({ 
            error: 'Failed to process the request due to an internal server error.',
            details: error instanceof Error ? error.message : 'An unknown error occurred.'
        }, { status: 500 });
    }
}