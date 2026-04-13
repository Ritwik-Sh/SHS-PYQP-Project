const express = require("express");
const fetch = require("node-fetch");
const { Dropbox } = require("dropbox");
// PDF editing
const { PDFDocument, StandardFonts, rgb, degrees } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const crypto = require("crypto");
const htmlPdf = require("html-pdf-node");
const fs = require("fs").promises;
const { execSync } = require("child_process");
console.clear();

// Derive a 32-byte key from WATERMARK_SECRET environment variable (recommended) or create one in-memory.
const rawSecret = process.env.WATERMARK_SECRET || null;
let derivedKey;
if (rawSecret) {
  // create a 32-byte key via SHA-256 of the secret
  derivedKey = crypto.createHash("sha256").update(rawSecret).digest();
  console.log("🔐 Watermark token key derived from WATERMARK_SECRET");
} else {
  // Fallback: ephemeral key — tokens won't survive server restarts
  derivedKey = crypto.randomBytes(32);
  console.warn(
    "⚠️ WARNING: WATERMARK_SECRET not set. Generated ephemeral key — tokens will break after restart. Set WATERMARK_SECRET to a stable secret to persist tokens across restarts.",
  );
}

function encryptUrlToToken(url) {
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // token: base64(iv).base64(tag).base64(encrypted)
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptTokenToUrl(token) {
  try {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], "base64");
    const tag = Buffer.from(parts[1], "base64");
    const encrypted = Buffer.from(parts[2], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch (e) {
    console.error("Failed to decrypt token:", e);
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
    return res
      .status(400)
      .json({ error: "Missing required 'path' query parameter." });
  }

  try {
    const accessToken = await getAccessToken();
    const dbx = new Dropbox({ accessToken, fetch });

    let result = await dbx.filesListFolder({ path: folderPath });
    let files = result.result.entries;

    // Handle pagination if more files exist
    while (result.result.has_more) {
      result = await dbx.filesListFolderContinue({
        cursor: result.result.cursor,
      });
      files = files.concat(result.result.entries);
    }

    // 🔥 Fetch temporary download links for each file and replace with server-side watermarked token links
    const filesWithLinks = await Promise.all(
      files.map(async (file) => {
        if (file[".tag"] === "file") {
          try {
            const linkResponse = await dbx.filesGetTemporaryLink({
              path: file.path_lower,
            });
            const originalLink = linkResponse.result.link;

            // encrypt the original link into a token so the frontend never sees the original URL
            const token = encryptUrlToToken(originalLink);
            const watermarkedPath = `/view?token=${encodeURIComponent(token)}`;
            return { ...file, download_link: watermarkedPath };
          } catch (err) {
            console.error(
              `❌ Error getting download link for ${file.name}:`,
              err,
            );
            return { ...file, download_link: null };
          }
        }
        return file;
      }),
    );

    res.json(filesWithLinks);
  } catch (error) {
    console.error("❌ Dropbox API Error:", JSON.stringify(error, null, 2));
    console.log(folderPath);
    res
      .status(500)
      .json({ error: error.message || "Dropbox API request failed" });
  }
});

// Watermarking endpoint: fetches a remote PDF (public URL) and returns a watermarked PDF
// Query params:
// - source: URL to the original PDF (required)
// - text: watermark text (optional, defaults to site)
app.get("/view", async (req, res) => {
  // Accept either a raw source URL (legacy) or an encrypted token returned by /files
  const token = req.query.token;
  const source = req.query.source;
  const text = req.query.text || "shs-pyqp-project.vercel.app";

  let resolvedSource = source;
  if (!resolvedSource && token) {
    resolvedSource = decryptTokenToUrl(token);
  }

  if (!resolvedSource) {
    return res
      .status(400)
      .send(
        '<center><h1><br><br>Session Expired!</h1><br>.<h3>Please try again on <a href="https://shs-pyqp-project.vercel.app">https://shs-pyqp-project.vercel.app</a>.</h3></center>',
      );
  }

  try {
    // Fetch the original PDF as an ArrayBuffer
    const upstream = await fetch(resolvedSource);
    if (!upstream.ok) {
      console.error(
        "Failed to fetch source PDF:",
        upstream.status,
        upstream.statusText,
      );
      return res.status(502).send("Failed to fetch source PDF");
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
        x: width / 5,
        y: height - fontSize,
        size: fontSize / 1.5,
        rotate: degrees(0),
        color: rgb(147 / 255, 187 / 255, 234 / 255),
        opacity: 0.7,
      });
    }

    const modifiedPdfBytes = await pdfDoc.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="SHS PYQP.pdf"`);
    res.send(Buffer.from(modifiedPdfBytes));
  } catch (err) {
    console.error("Error while watermarking:", err);
    res.status(500).send("Error watermarking PDF");
  }
});

// Print Quiz endpoint: generates a printable PDF version of a quiz
// Query params:
// - topic: the quiz filename (without .json extension)
app.get("/printQuiz", async (req, res) => {
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
    console.log("🔄 Generating quiz PDF:", topic);

    // Read the quiz JSON file
    const quizFilePath = path.join(
      __dirname,
      "public",
      "resources",
      "quizes",
      `${topic}.json`,
    );
    const quizData = JSON.parse(await fs.readFile(quizFilePath, "utf8"));

    // Create a new PDF document
    const pdfDoc = await PDFDocument.create();

    // Embed fonts
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const courierFont = await pdfDoc.embedFont(StandardFonts.Courier);

    // Try to load custom font
    let customFont = null;
    try {
      const fontPath = path.join(
        __dirname,
        "public",
        "resources",
        "JetBrainsMono-Regular.ttf",
      );
      const fontBytes = await fs.readFile(fontPath);
      customFont = await pdfDoc.embedFont(fontBytes);
    } catch (e) {
      console.log("⚠️  JetBrains Mono not found, using Courier for code");
    }

    const codeFont = customFont || courierFont;

    // Color scheme
    const COLOR_TEXT = rgb(0.102, 0.086, 0.078); // #1a1614
    const COLOR_TEXT_SECONDARY = rgb(0.42, 0.396, 0.38); // #6b6561
    const COLOR_ACCENT = rgb(0.851, 0.467, 0.024); // #d97706
    const COLOR_BORDER = rgb(0.906, 0.898, 0.882); // #e7e5e4
    const COLOR_CODE_BG = rgb(0.98, 0.973, 0.965); // #faf8f6
    const COLOR_ANSWER_BG = rgb(0.996, 0.953, 0.78); // #fef3c7

    // Page settings
    const pageWidth = 612; // 8.5 inches
    const pageHeight = 792; // 11 inches
    const margin = 54; // 0.75 inches
    const contentWidth = pageWidth - margin * 2;

    let currentY = pageHeight - margin;
    let currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
    let pageNumber = 1;

    // Helper function to add footer
    const addFooter = (page, pageNum) => {
      const footerY = 36; // 0.5 inches from bottom

      // Footer line
      page.drawLine({
        start: { x: margin, y: footerY + 18 },
        end: { x: pageWidth - margin, y: footerY + 18 },
        thickness: 0.5,
        color: COLOR_BORDER,
      });

      // Left: Project name
      page.drawText("SHS-PYQP-Project Resources", {
        x: margin,
        y: footerY,
        size: 8,
        font: helveticaFont,
        color: COLOR_TEXT_SECONDARY,
      });

      // Center: URL
      const url = "https://shs-pyqp-project.vercel.app";
      const urlWidth = helveticaFont.widthOfTextAtSize(url, 8);
      page.drawText(url, {
        x: (pageWidth - urlWidth) / 2,
        y: footerY,
        size: 8,
        font: helveticaFont,
        color: COLOR_TEXT_SECONDARY,
      });

      // Right: Topic
      const topicDisplay = topic
        .replace(/-/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase());
      const topicWidth = helveticaFont.widthOfTextAtSize(topicDisplay, 8);
      page.drawText(topicDisplay, {
        x: pageWidth - margin - topicWidth,
        y: footerY,
        size: 8,
        font: helveticaFont,
        color: COLOR_TEXT_SECONDARY,
      });

      // Page number
      const pageText = `Page ${pageNum}`;
      const pageTextWidth = helveticaFont.widthOfTextAtSize(pageText, 9);
      page.drawText(pageText, {
        x: pageWidth - margin - pageTextWidth,
        y: footerY + 30,
        size: 9,
        font: helveticaFont,
        color: COLOR_TEXT,
      });
    };

    // Helper function to clean text for PDF
    const cleanText = (text) => {
      if (!text) return "";
      return String(text)
        .replace(/\n/g, " ")
        .replace(/\r/g, "")
        .replace(/\t/g, "    ")
        .replace(/```(java|javascript|python|cpp|c\+\+|html|css)?\s*/gi, "")
        .replace(/```/g, "")
        .trim();
    };

    // Helper function to check if we need a new page
    const checkNewPage = (spaceNeeded) => {
      if (currentY - spaceNeeded < 80) {
        // 80 = margin + footer space
        addFooter(currentPage, pageNumber);
        currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
        currentY = pageHeight - margin;
        pageNumber++;
        return true;
      }
      return false;
    };

    // Helper function to draw wrapped text
    const drawWrappedText = (
      text,
      x,
      y,
      maxWidth,
      fontSize,
      font,
      color = COLOR_TEXT,
    ) => {
      text = cleanText(text); // Clean text before processing
      const words = text.split(" ");
      let line = "";
      let localY = y;
      const lineHeight = fontSize * 1.4;

      for (let i = 0; i < words.length; i++) {
        const testLine = line + words[i] + " ";
        const testWidth = font.widthOfTextAtSize(testLine, fontSize);

        if (testWidth > maxWidth && line !== "") {
          checkNewPage(lineHeight + 10);
          currentPage.drawText(line.trim(), {
            x: x,
            y: currentY,
            size: fontSize,
            font: font,
            color: color,
          });
          currentY -= lineHeight;
          line = words[i] + " ";
        } else {
          line = testLine;
        }
      }

      if (line.trim() !== "") {
        checkNewPage(lineHeight + 10);
        currentPage.drawText(line.trim(), {
          x: x,
          y: currentY,
          size: fontSize,
          font: font,
          color: color,
        });
        currentY -= lineHeight;
      }
    };

    // Helper function to draw code block with syntax highlighting
    const drawCodeBlock = (code, x, y, maxWidth) => {
      const fontSize = 8;
      const lineHeight = fontSize * 1.5;
      const padding = 0;

      // Clean code - remove language identifiers
      code = code.replace(/\`\`\`java/g, "").trim();
      const lines = code.split("\n");

      // Calculate block height
      const blockHeight = lines.length * lineHeight + padding * 2 + 4;
      checkNewPage(blockHeight + 10);

      // Draw background with proper positioning
      currentPage.drawRectangle({
        x: x,
        y: currentY - blockHeight + padding,
        width: maxWidth,
        height: blockHeight,
        color: COLOR_CODE_BG,
        borderColor: COLOR_BORDER,
        borderWidth: 1,
      });

      // Syntax highlighting colors
      const syntaxColors = {
        keyword: rgb(0.529, 0.267, 0.529), // Purple for keywords
        string: rgb(0.133, 0.545, 0.133), // Green for strings
        comment: rgb(0.502, 0.502, 0.502), // Gray for comments
        method: rgb(0.855, 0.647, 0.125), // Orange for methods
        type: rgb(0.0, 0.502, 0.502), // Teal for types like String, int
        default: COLOR_TEXT,
      };

      // Java keywords
      const keywords = new Set([
        "abstract",
        "assert",
        "boolean",
        "break",
        "byte",
        "case",
        "catch",
        "char",
        "class",
        "const",
        "continue",
        "default",
        "do",
        "double",
        "else",
        "enum",
        "extends",
        "final",
        "finally",
        "float",
        "for",
        "goto",
        "if",
        "implements",
        "import",
        "instanceof",
        "int",
        "interface",
        "long",
        "native",
        "new",
        "package",
        "private",
        "protected",
        "public",
        "return",
        "short",
        "static",
        "strictfp",
        "super",
        "switch",
        "synchronized",
        "this",
        "throw",
        "throws",
        "transient",
        "try",
        "void",
        "volatile",
        "while",
        "true",
        "false",
        "null",
      ]);

      // Common Java types and classes
      const types = new Set([
        "String",
        "Integer",
        "Double",
        "Float",
        "Boolean",
        "Character",
        "Long",
        "Short",
        "Byte",
        "Object",
        "System",
        "Math",
        "Scanner",
      ]);

      // Draw code lines with basic syntax highlighting
      let codeY = currentY - padding - lineHeight;
      for (const line of lines) {
        if (codeY < 80) {
          addFooter(currentPage, pageNumber);
          currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
          currentY = pageHeight - margin;
          pageNumber++;

          // Redraw background on new page
          const remainingLines = lines.length - lines.indexOf(line);
          const remainingHeight = remainingLines * lineHeight + padding * 2;
          currentPage.drawRectangle({
            x: x,
            y: currentY - remainingHeight + padding,
            width: maxWidth,
            height: remainingHeight,
            color: COLOR_CODE_BG,
            borderColor: COLOR_BORDER,
            borderWidth: 1,
          });

          codeY = currentY - padding - lineHeight;
        }

        let trimmedLine = line.replace(/\t/g, "    "); // Convert tabs to spaces
        let currentX = x + padding;

        // Simple tokenization for syntax highlighting
        const tokens = trimmedLine.split(/(\s+|[(){}\[\];,.])/);

        for (let t = 0; t < tokens.length; t++) {
          const token = tokens[t];
          const nextToken = tokens[t + 1];

          if (!token || token.match(/^\s+$/)) {
            // Whitespace - just advance position
            currentX += codeFont.widthOfTextAtSize(token, fontSize);
            continue;
          }

          let color = syntaxColors.default;

          // Determine token color
          if (keywords.has(token)) {
            color = syntaxColors.keyword;
          } else if (types.has(token)) {
            color = syntaxColors.type;
          } else if (token.match(/^".*"$|^'.*'$/)) {
            color = syntaxColors.string;
          } else if (token.match(/^\/\//)) {
            color = syntaxColors.comment;
          } else if (nextToken === "(") {
            // Method call - word followed by opening parenthesis
            color = syntaxColors.method;
          }

          currentPage.drawText(token, {
            x: currentX,
            y: codeY,
            size: fontSize,
            font: codeFont,
            color: color,
          });

          currentX += codeFont.widthOfTextAtSize(token, fontSize);
        }

        codeY -= lineHeight;
      }

      currentY = codeY - padding;
    };

    // Title Page
    currentY = pageHeight - 150;
    const topicDisplay = topic
      .replace(/-/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());
    const titleText = `${topicDisplay} Quiz`;
    const titleWidth = helveticaBold.widthOfTextAtSize(titleText, 24);

    currentPage.drawText(titleText, {
      x: (pageWidth - titleWidth) / 2,
      y: currentY,
      size: 24,
      font: helveticaBold,
      color: COLOR_TEXT,
    });

    currentY -= 50;
    const subtitleText = "SHS-PYQP-Project";
    const subtitleWidth = helveticaFont.widthOfTextAtSize(subtitleText, 11);
    currentPage.drawText(subtitleText, {
      x: (pageWidth - subtitleWidth) / 2,
      y: currentY,
      size: 11,
      font: helveticaFont,
      color: COLOR_TEXT_SECONDARY,
    });

    currentY -= 30;
    const countText = `Total Questions: ${quizData.length}`;
    const countWidth = helveticaFont.widthOfTextAtSize(countText, 11);
    currentPage.drawText(countText, {
      x: (pageWidth - countWidth) / 2,
      y: currentY,
      size: 11,
      font: helveticaFont,
      color: COLOR_TEXT_SECONDARY,
    });

    // Add footer to title page
    addFooter(currentPage, pageNumber);

    // New page for questions
    currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
    currentY = pageHeight - margin;
    pageNumber++;

    // Questions Section
    const sectionTitle = "QUESTIONS";
    const sectionWidth = helveticaBold.widthOfTextAtSize(sectionTitle, 18);
    currentPage.drawText(sectionTitle, {
      x: (pageWidth - sectionWidth) / 2,
      y: currentY,
      size: 18,
      font: helveticaBold,
      color: COLOR_ACCENT,
    });
    currentY -= 40;

    // Draw questions
    for (let i = 0; i < quizData.length; i++) {
      const question = quizData[i];
      const qNum = i + 1;

      checkNewPage(60);

      // Question number and text
      let qText = cleanText(question.question || "");

      // Check if question has code blocks (check original text)
      if ((question.question || "").includes("```")) {
        const parts = (question.question || "").split("```");
        for (let j = 0; j < parts.length; j++) {
          if (j % 2 === 0) {
            // Regular text
            if (parts[j].trim()) {
              const prefix = j === 0 ? `Q${qNum}. ` : "";
              drawWrappedText(
                prefix + parts[j].trim(),
                margin,
                currentY,
                contentWidth,
                10,
                helveticaFont,
              );
            }
          } else {
            // Code block with indentation
            currentY -= 8;
            drawCodeBlock(parts[j], margin + 20, currentY, contentWidth - 40);
            currentY -= 8;
          }
        }
      } else {
        drawWrappedText(
          `Q${qNum}. ${qText}`,
          margin,
          currentY,
          contentWidth,
          10,
          helveticaFont,
        );
      }

      currentY -= 12;

      // Options or answer space
      if (question.type === "mcq" || question.options) {
        const options = question.options || [];
        for (let j = 0; j < options.length; j++) {
          const letter = String.fromCharCode(65 + j); // A, B, C, D
          checkNewPage(25);
          drawWrappedText(
            `   ${letter}) ${cleanText(options[j])}`,
            margin + 20,
            currentY,
            contentWidth - 20,
            9,
            helveticaFont,
          );
          currentY -= 4;
        }
      } else if (question.type === "fib") {
        checkNewPage(25);
        currentPage.drawText("Answer: _________________________________", {
          x: margin + 20,
          y: currentY,
          size: 9,
          font: helveticaFont,
          color: COLOR_TEXT,
        });
        currentY -= 20;
      } else if (question.type === "passageFib") {
        let passage = cleanText(question.passage || "");
        let blankNum = 0;
        // Re-add blanks that were removed by cleanText
        const originalPassage = question.passage || "";
        const blanks = (originalPassage.match(/________/g) || []).length;
        for (let b = 0; b < blanks; b++) {
          passage = passage.replace("________", `(${b}) ________`);
        }

        checkNewPage(40);
        // Draw passage background
        const passageLines = passage.split("\n").length;
        const passageHeight = passageLines * 16 + 24;

        currentPage.drawRectangle({
          x: margin,
          y: currentY - passageHeight,
          width: contentWidth,
          height: passageHeight,
          color: COLOR_CODE_BG,
          borderColor: COLOR_BORDER,
          borderWidth: 1,
        });

        currentY -= 12;
        drawWrappedText(
          passage,
          margin + 12,
          currentY,
          contentWidth - 24,
          9,
          helveticaFont,
        );
      }

      currentY -= 12;
    }

    // Answer Key Section
    addFooter(currentPage, pageNumber);
    currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
    currentY = pageHeight - margin;
    pageNumber++;

    const answerTitle = "ANSWER KEY";
    const answerWidth = helveticaBold.widthOfTextAtSize(answerTitle, 18);
    currentPage.drawText(answerTitle, {
      x: (pageWidth - answerWidth) / 2,
      y: currentY,
      size: 18,
      font: helveticaBold,
      color: COLOR_ACCENT,
    });
    currentY -= 40;

    // Build compact answer strings
    let answerLine = "";
    const lineHeight = 14;
    const maxLineWidth = contentWidth;

    for (let i = 0; i < quizData.length; i++) {
      const question = quizData[i];
      const qNum = i + 1;
      let answerText = "";

      if (question.type === "mcq" || question.options) {
        const answerIdx = question.answer || 0;
        const letter = String.fromCharCode(97 + answerIdx); // lowercase a, b, c, d
        answerText = `Q${qNum}. ${letter}`;
      } else if (question.type === "fib") {
        const answer = question.answer;
        const answerStr = cleanText(
          Array.isArray(answer) ? answer[0] : String(answer),
        );
        answerText = `Q${qNum}. ${answerStr}`;
      } else if (question.type === "passageFib") {
        const answers = question.answer || {};
        const parts = [];
        for (const [key, val] of Object.entries(answers)) {
          if (key === "0") continue; // Skip example answer
          const v = Array.isArray(val) ? val[0] : val;
          parts.push(`(${key}) ${cleanText(v)}`);
        }
        answerText = `Q${qNum}. ${parts.join(", ")}`;
      }

      // Check if adding this answer would exceed line width
      const testLine = answerLine ? `${answerLine}; ${answerText}` : answerText;
      const testWidth = helveticaFont.widthOfTextAtSize(testLine, 9);

      if (testWidth > maxLineWidth && answerLine !== "") {
        // Draw current line and start new one
        checkNewPage(lineHeight + 5);
        currentPage.drawText(answerLine, {
          x: margin,
          y: currentY,
          size: 9,
          font: helveticaFont,
          color: COLOR_TEXT,
        });
        currentY -= lineHeight;
        answerLine = answerText;
      } else {
        answerLine = testLine;
      }
    }

    // Draw remaining line
    if (answerLine) {
      checkNewPage(lineHeight + 5);
      currentPage.drawText(answerLine, {
        x: margin,
        y: currentY,
        size: 9,
        font: helveticaFont,
        color: COLOR_TEXT,
      });
      currentY -= lineHeight;
    }

    // Add footer to last page
    addFooter(currentPage, pageNumber);

    // Save PDF
    const pdfBytes = await pdfDoc.save();

    console.log("✅ Quiz PDF generated successfully:", topic);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${topic}_quiz.pdf"`,
    );
    res.send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error("❌ Error generating quiz PDF:", error);
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
                        ul { text-align: left; color: #6b6561; }
                    </style>
                </head>
                <body>
                    <h1>Error generating quiz PDF</h1>
                    <div class="error">
                        <strong>Error:</strong> ${error.message}
                    </div>
                    <p>Please ensure:</p>
                    <ul>
                        <li>The quiz file exists at: <code>/public/resources/quizes/${topic}.json</code></li>
                        <li>All required packages are installed: <code>pdf-lib</code></li>
                    </ul>
                    <p><a href="/resources/">← Back to Resources</a></p>
                </body>
            </html>
        `);
  }
});

// Start the Express server
// app.listen(PORT, () => {
//   console.log(`🚀 Server running at http://localhost:${PORT}`);
// });

module.exports = app;
