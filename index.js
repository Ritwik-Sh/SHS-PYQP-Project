const express = require("express");
const fetch = require("node-fetch");
const { Dropbox } = require("dropbox");
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

        // 🔥 Fetch temporary download links for each file
        const filesWithLinks = await Promise.all(
            files.map(async (file) => {
                if (file[".tag"] === "file") {
                    try {
                        const linkResponse = await dbx.filesGetTemporaryLink({ path: file.path_lower });
                        return { ...file, download_link: linkResponse.result.link };
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



// Start the Express server
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
