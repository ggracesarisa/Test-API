import { NextResponse } from 'next/server';
import { GoogleGenAI, GenerateContentParameters, Part } from '@google/genai';

// ---------------------------------------------------
// 1. การตั้งค่าและ Prompt
// ---------------------------------------------------

// Initialize Gemini Client
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    // ใน Production ควรใช้ Error Handling ที่ดีกว่านี้ หรือใช้ Next.js build-time check
    throw new Error("GEMINI_API_KEY environment variable is not set.");
}
const ai = new GoogleGenAI({ apiKey });

// Prompt สำหรับการวิเคราะห์ภาพรองเท้า
const PROMPT: string = (
    "อยากให้ช่วย suggest เวลาที่แนะนำในการเป่าแห้งรองเท้า โดยสมมติว่าเราคือตู้อบรองเท้าสาธารณะ " +
    "ที่ทำการเป่าแห้งรองเท้าด้วยพัดลมความร้อน (พัดลม + ฮีตเตอร์) โดยตั้งสมมติฐานว่า ความร้อนไม่สูงเกินไป (40–55°C) " +
    "และเวลาอบไม่ควรเกิน 1 ชั่วโมง เพื่อลดความเสี่ยงรองเท้าเสียหาย\n\n" +
    "ส่วน output อยากให้รีเทินออกมาเป็น ประเภทของรองเท้า + คำอธิบายสั้นๆ ก่อน จากนั้นค่อยตามด้วยระยะเวลาที่แนะนำ\n\n" +
    "ตัวอย่าง output เช่น\n" +
    "รองเท้าผ้าใบ (ประเภท Sneakers) ความหนาปานกลาง\n" +
    "เวลาที่แนะนำ: 40 นาที"
);

// ---------------------------------------------------
// 2. Helper Function: แปลง File Object เป็น Gemini Part
// ---------------------------------------------------

/**
 * แปลง Web File object (จาก request.formData()) เป็นรูปแบบ Part ที่ Gemini API ต้องการ (Base64 Inline Data)
 */
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
// 3. Route Handler หลัก (POST)
// ---------------------------------------------------

export async function POST(request: Request) {
    try {
        // 1. รับ Form Data (ใช้ Native Web API)
        const formData = await request.formData();
        
        // คาดหวังว่า field name ของไฟล์คือ 'file'
        const fileEntry = formData.get('file');

        if (!fileEntry || typeof fileEntry === 'string') {
            return NextResponse.json({ error: 'Invalid or missing file upload (expecting field name "file").' }, { status: 400 });
        }
        
        // 2. แปลง File Object เป็น Gemini Part
        const imageFile = fileEntry as File;
        if (!imageFile.size) {
             return NextResponse.json({ error: 'Uploaded file is empty.' }, { status: 400 });
        }

        const imagePart = await fileToGenerativePart(imageFile);
        
        // 3. สร้าง Contents สำหรับ API Call
        const contents: GenerateContentParameters['contents'] = [
            { role: "user", parts: [{ text: PROMPT }, imagePart] }
        ];

        // 4. เรียกใช้ Gemini API
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: contents,
        });

        // ***************************************************************
        // 5. การตรวจสอบผลลัพธ์และการจัดการข้อผิดพลาด (Safety Filter/No Output)
        // ***************************************************************
        const candidate = response.candidates?.[0];
        const generatedText = candidate?.content?.parts?.[0]?.text;

        if (generatedText) {
            // สำเร็จ: ส่งคืนผลลัพธ์เมื่อมีข้อความ
            return NextResponse.json({
                filename: imageFile.name,
                filesize: imageFile.size,
                gemini_analysis: generatedText.trim(),
                model_used: "gemini-2.5-flash",
            });
        } 

        // ตรวจสอบ feedback ถ้าไม่สำเร็จ
        const feedback = response.promptFeedback;
        if (feedback && feedback.blockReason) {
            console.error("Content Blocked:", feedback.blockReason, feedback.safetyRatings);
            return NextResponse.json({ 
                error: `Content was blocked due to safety settings: ${feedback.blockReason}`, 
                safety_ratings: feedback.safetyRatings
            }, { status: 403 });
        }

        // กรณีที่โมเดลไม่สามารถสร้างเนื้อหาได้ด้วยเหตุผลอื่น
        console.error("Gemini failed to generate content:", response);
        return NextResponse.json({ 
            error: 'Gemini did not return any text output or the response structure was unexpected.',
            full_response_debug: response
        }, { status: 500 });

    } catch (error) {
        console.error("Global Catch Error:", error);
        
        // จัดการข้อผิดพลาดในการเรียก API หรือการประมวลผลไฟล์
        return NextResponse.json({ 
            error: 'Failed to process the request due to an internal server error.',
            details: error instanceof Error ? error.message : 'An unknown error occurred.'
        }, { status: 500 });
    }
}