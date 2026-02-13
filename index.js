const express = require("express");
const fetch = require("node-fetch");
const { Dropbox } = require("dropbox");
// PDF editing
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const crypto = require('crypto');
const hljs = require('highlight.js'); // Syntax highlighting
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

// PDF generation endpoint
app.get('/resources/pdf', async (req, res) => {
    const fileName = req.query.file;
    
    if (!fileName) {
        return res.status(400).send('Missing file parameter');
    }

    try {
        // Construct the path to the quiz JSON file
        const quizPath = path.join(__dirname, 'public', 'resources', fileName.endsWith('.json') ? fileName : fileName + '.json');
        const fs = require('fs');
        
        if (!fs.existsSync(quizPath)) {
            return res.status(404).send('Quiz file not found');
        }

        const quizData = JSON.parse(fs.readFileSync(quizPath, 'utf8'));
        
        // Create a new PDF document
        const pdfDoc = await PDFDocument.create();
        const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const helveticaItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

        pdfDoc.registerFontkit(fontkit);

        const fontBytes = fs.readFileSync(path.join(__dirname, 'resources', 'JetBrainsMono-Regular.ttf'));
        const consolasFont = await pdfDoc.embedFont(fontBytes);

        const pageWidth = 595.28; // A4 width in points
        const pageHeight = 841.89; // A4 height in points
        const margin = 50;
        const contentWidth = pageWidth - (2 * margin);
        
        const colors = {
            primary: rgb(147/255, 187/255, 234/255),      // #93bbea - primary
            secondary: rgb(146/255, 30/255, 28/255),      // #921e1c - secondary
            accent: rgb(214/255, 179/255, 41/255),       // #d6b329 - accent
            text: rgb(0.1, 0.1, 0.1),
            codeText: rgb(12/255, 20/255, 32/255), // #0c1420 - bg-secondary
            lightBackground: rgb(0.98, 0.98, 0.98),      // Very light gray for answer key
            mediumGray: rgb(0.5, 0.5, 0.5)
        };
        
        // Helper function to add header and footer to a page
        const addHeaderFooter = (page, pageNum, totalPages, quizTitle) => {
            const { width, height } = page.getSize();
            
            // Header - Left side: Quiz Title
            page.drawText(quizTitle, {
                x: margin,
                y: height - 30,
                size: 10,
                font: helveticaBold,
                color: colors.secondary
            });
            
            // Header - Right side: SHS-PYQP-Project
            const projectText = 'SHS-PYQP-Project';
            const projectTextWidth = helveticaBold.widthOfTextAtSize(projectText, 10);
            page.drawText(projectText, {
                x: width - margin - projectTextWidth,
                y: height - 30,
                size: 10,
                font: helveticaBold,
                color: colors.secondary
            });
            
            // Footer - Left: URL and Page number on same line
            const footerText = `https://shs-pyqp-project.vercel.app`;
            page.drawText(footerText, {
                x: margin,
                y: 20,
                size: 9,
                font: helveticaFont,
                color: colors.mediumGray
            });
            
            const pageText = `Page ${pageNum} of ${totalPages}`;
            const pageTextWidth = helveticaFont.widthOfTextAtSize(pageText, 9);
            page.drawText(pageText, {
                x: width - margin - pageTextWidth,
                y: 20,
                size: 9,
                font: helveticaFont,
                color: colors.mediumGray
            });
        };
        
        // Helper function to decode HTML entities
        const decodeHTMLEntities = (text) => {
            if (!text) return '';

            const htmlEntities = {
                '&quot;': '"',
                '&#34;': '"',
                '&apos;': "'",
                '&#39;': "'",
                '&lt;': '<',
                '&#60;': '<',
                '&gt;': '>',
                '&#62;': '>',
                '&amp;': '&',
                '&#38;': '&',
                '&nbsp;': ' ',
                '&#160;': ' ',
                '&ndash;': '-',
                '&#8211;': '-',
                '&mdash;': '-',
                '&#8212;': '-',
                '&lsquo;': "'",
                '&#8216;': "'",
                '&rsquo;': "'",
                '&#8217;': "'",
                '&ldquo;': '"',
                '&#8220;': '"',
                '&rdquo;': '"',
                '&#8221;': '"',
                '&hellip;': '...',
                '&#8230;': '...'
            };

            // Replace HTML entities
            for (const [entity, char] of Object.entries(htmlEntities)) {
                text = text.replace(new RegExp(entity, 'g'), char);
            }

            // Decode numeric entities (&#xxx; and &#xHHH;)
            text = text.replace(/&#(\d+);/g, (match, dec) => {
                const code = parseInt(dec, 10);
                // Only decode if within PDF-safe range
                if ((code >= 0x20 && code <= 0xFF) || code === 0x09 || code === 0x0A || code === 0x0D) {
                    return String.fromCharCode(code);
                }
                return match;
            });
            
            text = text.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
                const code = parseInt(hex, 16);
                // Only decode if within PDF-safe range
                if ((code >= 0x20 && code <= 0xFF) || code === 0x09 || code === 0x0A || code === 0x0D) {
                    return String.fromCharCode(code);
                }
                return match;
            });

            return text;
        };
        
        const sanitizeForPDF = (text) => {
            if (!text) return '';

            text = text.replace(/\\n/g, '\n');
            text = text.replace(/\\t/g, '\t');

            // Decode HTML entities using the helper function
            text = decodeHTMLEntities(text);

            // Remove unsupported unicode ONLY
            return text.replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '');
        };

        
        // Helper to parse highlight.js output and extract styled tokens
        const getHighlightedTokens = (code, language = 'java') => {
            try {
                const highlighted = hljs.highlight(code, { language, ignoreIllegals: true });
                
                // Parse HTML and convert to tokens with classes
                const lines = highlighted.value.split('\n');
                return lines.map(line => {
                    if (!line) {
                        return []; // Empty line
                    }
                    
                    const tokens = [];
                    // Match either <span class="...">content</span> or plain text between tags
                    const spanRegex = /<span class="([^"]+)">([^<]*)<\/span>|([^<>]+)/g;
                    let match;
                    
                    while ((match = spanRegex.exec(line)) !== null) {
                        if (match[1]) {
                            // This is a <span> tag with a class
                            let content = match[2];
                            content = decodeHTMLEntities(content);
                            if (content) {
                                tokens.push({ class: match[1], value: content });
                            }
                        } else if (match[3]) {
                            // This is plain text between tags
                            let content = match[3];
                            content = decodeHTMLEntities(content);
                            if (content) {
                                tokens.push({ class: '', value: content });
                            }
                        }
                    }
                    
                    return tokens.length > 0 ? tokens : [{ class: '', value: '' }];
                });
            } catch (e) {
                console.error('Highlighting error:', e);
                // Fallback: return as plain text
                return code.split('\n').map(line => [{ class: '', value: line }]);
            }
        };
        
        // Map highlight.js classes to colors
        const getTokenColor = (className) => {
            if (!className) return null; // Use default
            
            // Log to debug (remove after testing)
            // console.log('Class:', className);
            
            // highlight.js uses "hljs-" prefix
            if (className.includes('hljs-keyword')) return rgb(0/255, 0/255, 200/255); // Blue for keywords
            if (className.includes('hljs-title') && className.includes('class')) return rgb(200/255, 0/255, 200/255); // Magenta for classes
            if (className.includes('hljs-title') && className.includes('function')) return rgb(153/255, 0/255, 153/255); // Purple for function names
            if (className.includes('hljs-built_in')) return rgb(0/255, 128/255, 128/255); // Teal for built-in classes (System, String, etc.)
            if (className.includes('hljs-string')) return rgb(163/255, 21/255, 21/255); // Dark red for strings
            if (className.includes('hljs-comment')) return rgb(100/255, 100/255, 100/255); // Gray for comments
            if (className.includes('hljs-number')) return rgb(9/255, 134/255, 88/255); // Dark green for numbers
            if (className.includes('hljs-literal')) return rgb(0/255, 102/255, 204/255); // Light blue for literals (true, false, null)
            if (className.includes('hljs-type')) return rgb(38/255, 139/255, 210/255); // Cyan for types
            if (className.includes('hljs-variable')) return rgb(0/255, 0/255, 0/255); // Black for variables
            
            return null; // Use default color
        };
        
        // Helper to draw a single code line with highlight.js styling
        const drawCodeLine = (page, lineTokens, x, y, fontSize, font, colors, codeText) => {
            let currentX = x;
            
            // lineTokens is an array of tokens: [{ class: 'hljs-keyword', value: 'public' }, ...]
            for (const token of lineTokens) {
                const displayValue = token.value.replace(/\t/g, '    '); // Convert tabs to spaces
                let color = getTokenColor(token.class);
                if (!color) color = colors.codeText; // Default color
                
                page.drawText(displayValue, {
                    x: currentX,
                    y,
                    size: fontSize,
                    font: codeText,
                    color
                });
                
                currentX += font.widthOfTextAtSize(displayValue, fontSize);
            }
        };
        
        // Helper function to extract and format code from question
        const extractCodeAndText = (questionText) => {
            const codeBlockRegex = /```(?:java)?\n?([\s\S]*?)```/g;
            const parts = [];
            let lastIndex = 0;
            let match;
            
            while ((match = codeBlockRegex.exec(questionText)) !== null) {
                // Add text before code block
                if (match.index > lastIndex) {
                    const textBefore = questionText.substring(lastIndex, match.index).trim();
                    if (textBefore) {
                        // Clean newlines and special characters from regular text
                        const cleanedText = sanitizeForPDF(textBefore).replace(/[\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
                        if (cleanedText) {
                            parts.push({ type: 'text', content: cleanedText });
                        }
                    }
                }
                // Add code block (preserve newlines in code, sanitize special chars)
                const codeContent = sanitizeForPDF(match[1]).replace(/\r/g, '').replace(/\t/g, '    ');
                if (codeContent.trim()) {
                    parts.push({ type: 'code', content: codeContent });
                }
                lastIndex = match.index + match[0].length;
            }
            
            // Add remaining text
            if (lastIndex < questionText.length) {
                const textAfter = questionText.substring(lastIndex).trim();
                if (textAfter) {
                    // Clean newlines and special characters from regular text
                    const cleanedText = sanitizeForPDF(textAfter).replace(/[\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
                    if (cleanedText) {
                        parts.push({ type: 'text', content: cleanedText });
                    }
                }
            }
            
            // If no code blocks found, return cleaned text
            if (parts.length === 0) {
                const cleanedText = sanitizeForPDF(questionText).replace(/[\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
                return cleanedText ? [{ type: 'text', content: cleanedText }] : [];
            }
            
            return parts;
        };
        
        // Helper function to wrap text (for regular text only, not code)
        const wrapText = (text, font, fontSize, maxWidth) => {
            // Safety: Remove ALL newlines, special chars, and normalize whitespace
            const cleanedText = sanitizeForPDF(text)
                .replace(/[\n\r]/g, ' ')    // Remove newlines
                .replace(/\s+/g, ' ')        // Normalize whitespace
                .trim();
            
            if (!cleanedText) return [];
            
            const words = cleanedText.split(' ');
            const lines = [];
            let currentLine = '';
            
            for (const word of words) {
                const testLine = currentLine ? `${currentLine} ${word}` : word;
                const testWidth = font.widthOfTextAtSize(testLine, fontSize);
                
                if (testWidth > maxWidth && currentLine) {
                    lines.push(currentLine);
                    currentLine = word;
                } else {
                    currentLine = testLine;
                }
            }
            
            if (currentLine) {
                lines.push(currentLine);
            }
            
            return lines;
        };
        
        // Create title page
        let page = pdfDoc.addPage([pageWidth, pageHeight]);
        let yPosition = pageHeight - 150;
        
        const quizTitle = sanitizeForPDF(
            fileName.replace('.json', '').replace(/-/g, ' ').replace(/_/g, ' ')
                .split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ')
        );
        
        // Title
        const titleLines = wrapText(quizTitle, helveticaBold, 24, contentWidth);
        titleLines.forEach(line => {
            const titleWidth = helveticaBold.widthOfTextAtSize(line, 24);
            page.drawText(line, {
                x: (pageWidth - titleWidth) / 2,
                y: yPosition,
                size: 24,
                font: helveticaBold,
                color: colors.secondary
            });
            yPosition -= 35;
        });
        
        yPosition -= 20;
        
        // Subtitle
        const subtitle = `Total Questions: ${quizData.length}`;
        const subtitleWidth = helveticaItalic.widthOfTextAtSize(subtitle, 14);
        page.drawText(subtitle, {
            x: (pageWidth - subtitleWidth) / 2,
            y: yPosition,
            size: 14,
            font: helveticaItalic,
            color: colors.mediumGray
        });
        
        yPosition -= 60;
        
        // Student info box
        const boxHeight = 100;
        page.drawRectangle({
            x: margin,
            y: yPosition - boxHeight,
            width: contentWidth,
            height: boxHeight,
            borderColor: colors.mediumGray,
            borderWidth: 1
        });
        
        const fieldY = yPosition - 30;
        const fieldSpacing = contentWidth / 3;
        
        ['Name:', 'Class:', 'Date:'].forEach((label, idx) => {
            page.drawText(label, {
                x: margin + 10 + (idx * fieldSpacing),
                y: fieldY,
                size: 10,
                font: helveticaBold,
                color: colors.mediumGray
            });
            
            page.drawLine({
                start: { x: margin + 10 + (idx * fieldSpacing), y: fieldY - 25 },
                end: { x: margin + 10 + (idx * fieldSpacing) + fieldSpacing - 20, y: fieldY - 25 },
                thickness: 0.5,
                color: colors.text
            });
        });
        
        addHeaderFooter(page, 1, 'XX', quizTitle); // Will update page numbers later
        
        // Questions section
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        yPosition = pageHeight - 80;
        
        // Section title
        page.drawText('Questions', {
            x: margin,
            y: yPosition,
            size: 18,
            font: helveticaBold,
            color: colors.secondary
        });
        
        page.drawLine({
            start: { x: margin, y: yPosition - 5 },
            end: { x: pageWidth - margin, y: yPosition - 5 },
            thickness: 2,
            color: colors.secondary
        });
        
        yPosition -= 40;
        
        const questionsStartPage = pdfDoc.getPages().length;
        
        // Add questions
        quizData.forEach((question, index) => {
            const questionNum = index + 1;
            const isFIB = question.type === 'fib';
            
            // Check if we need a new page
            const estimatedHeight = 150; // Rough estimate
            if (yPosition < margin + estimatedHeight) {
                page = pdfDoc.addPage([pageWidth, pageHeight]);
                yPosition = pageHeight - 80;
            }
            
            // Question number
            page.drawText(`Question ${questionNum}`, {
                x: margin,
                y: yPosition,
                size: 11,
                font: helveticaBold,
                color: colors.secondary
            });
            yPosition -= 20;
            
            // Question text with code block support
            const questionParts = extractCodeAndText(question.question);
            
            questionParts.forEach(part => {
                if (yPosition < margin + 100) {
                    page = pdfDoc.addPage([pageWidth, pageHeight]);
                    yPosition = pageHeight - 80;
                }
                
                if (part.type === 'text') {
                    const questionLines = wrapText(part.content, helveticaFont, 11, contentWidth);
                    questionLines.forEach(line => {
                        if (yPosition < margin + 50) {
                            page = pdfDoc.addPage([pageWidth, pageHeight]);
                            yPosition = pageHeight - 80;
                        }
                        page.drawText(line, {
                            x: margin,
                            y: yPosition,
                            size: 11,
                            font: helveticaFont,
                            color: colors.text
                        });
                        yPosition -= 18;
                    });
                } else if (part.type === 'code') {
                    // Draw code block with background
                    // part.content is already sanitized in extractCodeAndText, don't sanitize again
                    const codeContent = part.content;
                    
                    // Split by newlines FIRST to count actual lines
                    const codeLines = codeContent.split('\n').filter(line => line !== undefined);
                    
                    // Get highlighted tokens using highlight.js
                    const highlightedLines = getHighlightedTokens(codeContent, 'java');
                    const codeHeight = (highlightedLines.length * 14) + 20; // 14px per line + padding
                    
                    // Check if code block fits on current page
                    if (yPosition < margin + codeHeight + 20) {
                        page = pdfDoc.addPage([pageWidth, pageHeight]);
                        yPosition = pageHeight - 80;
                    }
                    
                    // Draw background rectangle
                    page.drawRectangle({
                        x: margin,
                        y: yPosition - codeHeight,
                        width: contentWidth,
                        height: codeHeight,
                        color: colors.primary,
                        borderRadius: 12,
                    });
                    
                    yPosition -= 10; // Top padding
                    
                    // Draw code lines with syntax highlighting
                    highlightedLines.forEach((lineTokens, idx) => {
                        if (lineTokens && lineTokens.length > 0) {
                            drawCodeLine(page, lineTokens, margin + 10, yPosition, 9, consolasFont, colors, consolasFont);
                        } else {
                            // Empty line - just move down
                        }
                        yPosition -= 14;
                    });
                    
                    yPosition -= 10; // Bottom padding
                }
            });
            
            yPosition -= 10;
            
            // Options (MCQ only)
            if (!isFIB && question.options) {
                question.options.forEach((option, optIdx) => {
                    if (yPosition < margin + 50) {
                        page = pdfDoc.addPage([pageWidth, pageHeight]);
                        yPosition = pageHeight - 80;
                    }
                    
                    const letter = String.fromCharCode(65 + optIdx);
                    // Clean option text to remove newlines and special characters
                    const cleanOption = sanitizeForPDF(option).replace(/[\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
                    const optionText = `${letter}. ${cleanOption}`;
                    const optionLines = wrapText(optionText, helveticaFont, 10, contentWidth - 20);
                    
                    optionLines.forEach((line, lineIdx) => {
                        page.drawText(lineIdx === 0 ? line : `    ${line}`, {
                            x: margin + 20,
                            y: yPosition,
                            size: 10,
                            font: helveticaFont,
                            color: colors.text
                        });
                        yPosition -= 16;
                    });
                });
            }
            
            yPosition -= 5; // Small gap before answer line
            
            page.drawText('Answer:', {
                x: margin,
                y: yPosition,
                size: 9,
                font: helveticaBold,
                color: colors.mediumGray
            });
            
            page.drawLine({
                start: { x: margin + 50, y: yPosition },
                end: { x: pageWidth - margin, y: yPosition },
                thickness: 0.5,
                color: colors.text
            });
            
            yPosition -= 35;
        });
        
        // Answer Key section
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        yPosition = pageHeight - 80;
        
        // Add light background to entire answer key section
        page.drawRectangle({
            x: 0,
            y: 0,
            width: pageWidth,
            height: pageHeight,
            color: colors.lightBackground
        });
        
        page.drawText('Answer Key', {
            x: margin,
            y: yPosition,
            size: 18,
            font: helveticaBold,
            color: colors.secondary
        });
        
        page.drawLine({
            start: { x: margin, y: yPosition - 5 },
            end: { x: pageWidth - margin, y: yPosition - 5 },
            thickness: 2,
            color: colors.secondary
        });
        
        yPosition -= 30;
        
        // Create compact answer list - fit multiple answers per line
        let currentLineAnswers = [];
        let currentLineWidth = 0;
        const answerSpacing = 15; // Space between answers
        const maxLineWidth = contentWidth - 20;
        
        quizData.forEach((question, index) => {
            const questionNum = index + 1;
            const isFIB = question.type === 'fib';
            
            // Format answer
            let answerDisplay = '';
            if (isFIB) {
                const answerValue = Array.isArray(question.answer) 
                    ? question.answer.join('/') 
                    : question.answer.toString();
                // Clean answer text - remove special characters
                answerDisplay = `${questionNum}. ${sanitizeForPDF(answerValue).replace(/[\n\r]/g, ' ').replace(/\s+/g, ' ').trim()}`;
            } else {
                const answerIndex = question.answer;
                const answerLetter = String.fromCharCode(65 + answerIndex);
                answerDisplay = `${questionNum}. ${answerLetter}`;
            }
            
            // Calculate width of this answer
            const answerWidth = helveticaFont.widthOfTextAtSize(answerDisplay, 10);
            
            // Check if we need to start a new line
            if (currentLineWidth + answerWidth + answerSpacing > maxLineWidth && currentLineAnswers.length > 0) {
                // Draw current line
                if (yPosition < margin + 30) {
                    page = pdfDoc.addPage([pageWidth, pageHeight]);
                    // Add background to new page
                    page.drawRectangle({
                        x: 0,
                        y: 0,
                        width: pageWidth,
                        height: pageHeight,
                        color: colors.lightBackground
                    });
                    yPosition = pageHeight - 80;
                }
                
                let xPosition = margin;
                currentLineAnswers.forEach(answerObj => {
                    page.drawText(answerObj.text, {
                        x: xPosition,
                        y: yPosition,
                        size: 10,
                        font: helveticaFont,
                        color: colors.text
                    });
                    xPosition += answerObj.width + answerSpacing;
                });
                
                yPosition -= 20;
                currentLineAnswers = [];
                currentLineWidth = 0;
            }
            
            // Add to current line
            currentLineAnswers.push({
                text: answerDisplay,
                width: answerWidth
            });
            currentLineWidth += answerWidth + answerSpacing;
        });
        
        // Draw remaining answers
        if (currentLineAnswers.length > 0) {
            if (yPosition < margin + 30) {
                page = pdfDoc.addPage([pageWidth, pageHeight]);
                // Add background to new page
                page.drawRectangle({
                    x: 0,
                    y: 0,
                    width: pageWidth,
                    height: pageHeight,
                    color: colors.lightBackground
                });
                yPosition = pageHeight - 80;
            }
            
            let xPosition = margin;
            currentLineAnswers.forEach(answerObj => {
                page.drawText(answerObj.text, {
                    x: xPosition,
                    y: yPosition,
                    size: 10,
                    font: helveticaFont,
                    color: colors.text
                });
                xPosition += answerObj.width + answerSpacing;
            });
        }
        
        // Update page numbers
        const pages = pdfDoc.getPages();
        const totalPages = pages.length;
        pages.forEach((p, idx) => {
            addHeaderFooter(p, idx + 1, totalPages, quizTitle);
        });
        
        // Save and send PDF
        const pdfBytes = await pdfDoc.save();
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${quizTitle}.pdf"`);
        res.send(Buffer.from(pdfBytes));
        
    } catch (error) {
        console.error('Error generating PDF:', error);
        res.status(500).send('Error generating PDF');
    }
});

// Start the Express server
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// module.exports = app;