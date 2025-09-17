const express = require("express");
const fetch = require("node-fetch");
const { Dropbox } = require("dropbox");
// PDF editing
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const crypto = require('crypto');

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

// 🔥 Serve static files (index.html, script.js, style.css)
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
    const text = req.query.text || 'shs-pyqp-project.onrender.com';

    let resolvedSource = source;
    if (!resolvedSource && token) {
        resolvedSource = decryptTokenToUrl(token);
    }

    if (!resolvedSource) {
        return res.status(400).send('<center><h1><br><br>Session Expiered!</h1><br>.<h3>Please try again on <a href="https://shs-pyqp-project.onrender.com">https://shs-pyqp-project.onrender.com</a>.</h3></center>');
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

// No periodic in-memory cleanup needed — tokens are self-contained encrypted values.



// Start the Express server
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
