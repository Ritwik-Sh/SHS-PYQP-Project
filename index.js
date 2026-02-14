const express = require("express");
const fetch = require("node-fetch");
const { Dropbox } = require("dropbox");
// PDF editing
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const crypto = require('crypto');
const htmlPdf = require('html-pdf-node');
const fs = require('fs').promises;
const { execSync } = require('child_process');
console.clear();

// Derive a 32-byte key from WATERMARK_SECRET environment variable (recommended) or create one in-memory.
const rawSecret = process.env.WATERMARK_SECRET || null;
let derivedKey;
if (rawSecret) {
    // create a 32-byte key via SHA-256 of the secret
    derivedKey = crypto.createHash('sha256').update(rawSecret).digest();
    console.log('🔐 Watermark token key derived from WATERMARK_SECRET');
} else {
    // Fallback: ephemeral key — tokens won't survive server restarts
    derivedKey = crypto.randomBytes(32);
    console.warn('⚠️ WARNING: WATERMARK_SECRET not set. Generated ephemeral key — tokens will break after restart. Set WATERMARK_SECRET to a stable secret to persist tokens across restarts.');
}

function encryptUrlToToken(url) {
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // token: base64(iv).base64(tag).base64(encrypted)
    return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptTokenToUrl(token) {
    try {
        if (!token) return null;
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const iv = Buffer.from(parts[0], 'base64');
        const tag = Buffer.from(parts[1], 'base64');
        const encrypted = Buffer.from(parts[2], 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return decrypted.toString('utf8');
    } catch (e) {
        console.error('Failed to decrypt token:', e);
        return null;
    }
}
const path = require("path");
// Setup .env
require("dotenv").config();

const app = express();
const PORT = 3000;

const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// Serve static files (index.html, script.js, style.css)
app.use(express.static(path.join(__dirname, "public")));


async function getAccessToken() {
    const response = await fetch("https://api.dropbox.com/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            refresh_token: REFRESH_TOKEN,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: "refresh_token",
        }),
    });

    const data = await response.json();

    if (!response.ok) {
        console.error("❌ Error getting access token:", data);
        throw new Error("Failed to get Dropbox access token.");
    }

    return data.access_token;
}


// 🔥 Route to serve index.html (Handled by express.static already)
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 🔥 API Route to get file list from Dropbox folder
app.get("/files", async (req, res) => {
    const folderPath = "/SHS-PYQP-Project/" + req.query.path;

    if (!folderPath) {
        return res.status(400).json({ error: "Missing required 'path' query parameter." });
    }

    try {
        const accessToken = await getAccessToken();
        const dbx = new Dropbox({ accessToken, fetch });

        let result = await dbx.filesListFolder({ path: folderPath });
        let files = result.result.entries;

        // Handle pagination if more files exist
        while (result.result.has_more) {
            result = await dbx.filesListFolderContinue({ cursor: result.result.cursor });
            files = files.concat(result.result.entries);
        }

        // 🔥 Fetch temporary download links for each file and replace with server-side watermarked token links
        const filesWithLinks = await Promise.all(
            files.map(async (file) => {
                if (file[".tag"] === "file") {
                    try {
                        const linkResponse = await dbx.filesGetTemporaryLink({ path: file.path_lower });
                        const originalLink = linkResponse.result.link;

                        // encrypt the original link into a token so the frontend never sees the original URL
                        const token = encryptUrlToToken(originalLink);
                        const watermarkedPath = `/view?token=${encodeURIComponent(token)}`;
                        return { ...file, download_link: watermarkedPath };
                    } catch (err) {
                        console.error(`❌ Error getting download link for ${file.name}:`, err);
                        return { ...file, download_link: null };
                    }
                }
                return file;
            })
        );

        res.json(filesWithLinks);
    } catch (error) {
        console.error("❌ Dropbox API Error:", JSON.stringify(error, null, 2));
        console.log(folderPath)
        res.status(500).json({ error: error.message || "Dropbox API request failed" });
    }
});


// Watermarking endpoint: fetches a remote PDF (public URL) and returns a watermarked PDF
// Query params:
// - source: URL to the original PDF (required)
// - text: watermark text (optional, defaults to site)
app.get('/view', async (req, res) => {
    // Accept either a raw source URL (legacy) or an encrypted token returned by /files
    const token = req.query.token;
    const source = req.query.source;
    const text = req.query.text || 'shs-pyqp-project.vercel.app';

    let resolvedSource = source;
    if (!resolvedSource && token) {
        resolvedSource = decryptTokenToUrl(token);
    }

    if (!resolvedSource) {
        return res.status(400).send('<center><h1><br><br>Session Expired!</h1><br>.<h3>Please try again on <a href="https://shs-pyqp-project.vercel.app">https://shs-pyqp-project.vercel.app</a>.</h3></center>');
    }

    try {
    // Fetch the original PDF as an ArrayBuffer
    const upstream = await fetch(resolvedSource);
        if (!upstream.ok) {
            console.error('Failed to fetch source PDF:', upstream.status, upstream.statusText);
            return res.status(502).send('Failed to fetch source PDF');
        }

        const arrayBuffer = await upstream.arrayBuffer();

        // Load and modify with pdf-lib
        const pdfDoc = await PDFDocument.load(Buffer.from(arrayBuffer));
        const pages = pdfDoc.getPages();

        // Embed a standard font to measure text width
        const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

        for (const page of pages) {
            const { width, height } = page.getSize();

            // Choose font size proportional to page
            const fontSize = Math.max(20, Math.min(width, height) / 15);

            // Measure text width using the embedded font
            let textWidth = 0;
            try {
                textWidth = helveticaFont.widthOfTextAtSize(text, fontSize);
            } catch (e) {
                // Fallback estimate
                textWidth = text.length * fontSize * 0.5;
            }

            const x = (width - textWidth) * 1.5;
            // console.log(width, height, fontSize, textWidth, x);
            const y = (height - fontSize) / 3;

            page.drawText(text, {
                x,
                y,
                size: fontSize,
                rotate: degrees(45),
                color: rgb(147 / 255, 187 / 255, 234 / 255),
                opacity: 0.25,
            });
            page.drawText(text, {
                x: width/5,
                y: height - fontSize,
                size: fontSize/1.5,
                rotate: degrees(0),
                color: rgb(147 / 255, 187 / 255, 234 / 255),
                opacity: 0.70
            });
        }

        const modifiedPdfBytes = await pdfDoc.save();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="SHS PYQP.pdf"`);
        res.send(Buffer.from(modifiedPdfBytes));
    } catch (err) {
        console.error('Error while watermarking:', err);
        res.status(500).send('Error watermarking PDF');
    }
});

// Print Quiz endpoint: generates a printable PDF version of a quiz
// Query params:
// - topic: the quiz filename (without .json extension)
app.get('/printQuiz', async (req, res) => {
    const topic = req.query.topic;
    
    if (!topic) {
        return res.status(400).send(`
            <html>
                <head>
                    <style>
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                            max-width: 600px;
                            margin: 100px auto;
                            padding: 20px;
                            text-align: center;
                        }
                        h1 { color: #d97706; }
                        p { color: #6b6561; }
                        code { 
                            background: #faf8f6; 
                            padding: 2px 6px; 
                            border-radius: 3px; 
                        }
                    </style>
                </head>
                <body>
                    <h1>Error: Missing topic parameter</h1>
                    <p>Please specify a quiz topic using <code>?topic=filename</code></p>
                    <p>Example: <code>/printQuiz?topic=class-10-java</code></p>
                </body>
            </html>
        `);
    }

    try {
        // Read the quiz JSON file
        const quizFilePath = path.join(__dirname, 'public', 'resources', `${topic}.json`);
        let quizData;
        
        try {
            const fileContent = await fs.readFile(quizFilePath, 'utf8');
            quizData = JSON.parse(fileContent);
        } catch (fileError) {
            throw new Error(`Quiz file not found: ${topic}.json`);
        }

        // For Vercel serverless, use /tmp directory
        const tmpDir = '/tmp';
        const timestamp = Date.now();
        const tempDataPath = path.join(tmpDir, `${topic}_${timestamp}_data.json`);
        const outputPdfPath = path.join(tmpDir, `${topic}_${timestamp}_quiz.pdf`);
        
        // Write quiz data to temp file
        await fs.writeFile(tempDataPath, JSON.stringify(quizData));

        // Path to Python script (should be in same directory as index.js)
        const pythonScriptPath = path.join(__dirname, 'generate_quiz_pdf.py');
        
        // Path to custom font (optional)
        const fontPath = path.join(__dirname, 'public', 'resources', 'JetBrainsMono-Regular.ttf');
        const fontExists = await fs.access(fontPath).then(() => true).catch(() => false);
        
        // Execute Python script
        console.log('🔄 Generating quiz PDF:', topic);
        
        const pythonCommand = fontExists 
            ? `python3 ${pythonScriptPath} ${tempDataPath} ${topic} ${outputPdfPath} ${fontPath}`
            : `python3 ${pythonScriptPath} ${tempDataPath} ${topic} ${outputPdfPath}`;
        
        execSync(pythonCommand, {
            stdio: 'pipe',
            encoding: 'utf8'
        });

        // Read generated PDF
        const pdfBuffer = await fs.readFile(outputPdfPath);

        console.log('✅ Quiz PDF generated successfully:', topic);
        
        // Send PDF to client
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${topic}_quiz.pdf"`);
        res.send(pdfBuffer);

        // Cleanup temp files (async, don't wait)
        setTimeout(async () => {
            await fs.unlink(tempDataPath).catch(() => {});
            await fs.unlink(outputPdfPath).catch(() => {});
        }, 1000);

    } catch (error) {
        console.error('❌ Error generating quiz PDF:', error);
        res.status(500).send(`
            <html>
                <head>
                    <style>
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                            max-width: 600px;
                            margin: 100px auto;
                            padding: 20px;
                        }
                        h1 { color: #d97706; }
                        .error { 
                            background: #fef3c7; 
                            padding: 15px; 
                            border-left: 3px solid #d97706;
                            margin: 20px 0;
                            border-radius: 6px;
                        }
                        code { 
                            background: #faf8f6; 
                            padding: 2px 6px; 
                            border-radius: 3px; 
                        }
                    </style>
                </head>
                <body>
                    <h1>Error generating quiz PDF</h1>
                    <div class="error">
                        <strong>Error:</strong> ${error.message}
                    </div>
                    <p>Please ensure:</p>
                    <ul style="text-align: left; color: #6b6561;">
                        <li>The quiz file exists at: <code>/public/resources/${topic}.json</code></li>
                        <li>Python 3 is installed with reportlab</li>
                        <li>The generate_quiz_pdf.py script is in the same directory</li>
                    </ul>
                    <p><a href="/resources/">← Back to Resources</a></p>
                </body>
            </html>
        `);
    }
});


// Start the Express server
// app.listen(PORT, () => {
//     console.log(`🚀 Server running at http://localhost:${PORT}`);
// });

module.exports = app;