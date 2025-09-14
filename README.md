# SHS PYQP Project 📚

A web application for accessing Sheiling House School's Past Year Question Papers, built with Node.js and Express, integrated with Dropbox for file storage.

## 🌟 Features

- **Grade-based Navigation**: Browse question papers by class (6-11)
- **Subject Organization**: Access papers organized by subjects including:
  - Mathematics, Computer Applications, Physics, Chemistry, Biology
  - English Literature & Language, Hindi, Sanskrit, French
  - History & Civics, Geography, Environmental Science
  - Art, Music, Physical Education, Mass Communications, and more
- **Responsive Design**: Mobile-friendly interface with modern UI
- **Direct Downloads**: Seamless PDF downloads through Dropbox integration
- **Contribution System**: Embedded form for users to contribute new papers

## 🚀 Tech Stack

- **Backend**: Node.js with Express.js
- **File Storage**: Dropbox API integration
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Styling**: Custom CSS with FontAwesome icons
- **Deployment**: Configured for Vercel/Render

## 📁 Project Structure

```
shs-pyqp-project/
├── public/
│   ├── index.html          # Main HTML file
│   ├── script.js           # Frontend JavaScript
│   ├── style.css           # Styling
│   ├── logo.png            # School logo
│   └── sitemap.xml         # SEO sitemap
├── scripts/
│   └── script.js           # Additional scripts
├── index.js                # Main server file
├── package.json            # Dependencies
├── .env                    # Environment variables (not included)
├── .gitignore             # Git ignore rules
└── README.md              # This file
```

## 🛠️ Installation & Setup

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn
- Dropbox account with API access

### Environment Variables
Create a `.env` file in the root directory:

```env
REFRESH_TOKEN=your_dropbox_refresh_token
CLIENT_ID=your_dropbox_client_id
CLIENT_SECRET=your_dropbox_client_secret
```

### Installation Steps

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd shs-pyqp-project
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Set up environment variables**:
   - Copy `.env.example` to `.env`
   - Fill in your Dropbox API credentials

4. **Start the development server**:
   ```bash
   npm run dev
   ```

5. **Access the application**:
   - Open `http://localhost:3000` in your browser

## 🔧 Configuration

### Dropbox Setup
1. Create a Dropbox app at [Dropbox Developer Console](https://www.dropbox.com/developers/apps)
2. Generate access tokens and refresh tokens
3. Organize files in Dropbox following this structure:
   ```
   /SHS-PYQP-Project/
   ├── 6-Cls/
   ├── 7-Cls/
   ├── 8-Cls/
   ├── 9-Cls/
   ├── 10-Cls/
   └── 11-Cls/
   ```

### File Naming Convention
Files should be named using the pattern:
```
SubjectName()Session()TestType.pdf
```
Example: `Mathematics()2023-2024()Final Exam.pdf`

## 📱 Usage

1. **Select Class**: Choose your grade level (6-11)
2. **Pick Subject**: Select the subject you need papers for
3. **Download Papers**: Click on any paper to download directly
4. **Contribute**: Use the "Contribute a Paper" button to submit new papers

## 🎨 Customization

### Styling
- Modify `public/style.css` for design changes
- CSS variables are defined in `:root` for easy theming
- Responsive breakpoints: 720px for mobile/desktop

### Adding Subjects
1. Add subject div in `index.html` with appropriate class combinations
2. Update the subject filtering logic in `script.js`
3. Ensure proper folder structure in Dropbox

## 🚀 Deployment

### Vercel
1. Connect your repository to Vercel
2. Add environment variables in Vercel dashboard
3. Deploy automatically on push

### Render
1. Connect repository to Render
2. Set build command: `npm install`
3. Set start command: `node index.js`
4. Add environment variables

## 📊 API Endpoints

- `GET /` - Serves the main application
- `GET /files?path=<folder_path>` - Fetches file list from Dropbox folder

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-feature`
3. Commit changes: `git commit -am 'Add new feature'`
4. Push to branch: `git push origin feature/new-feature`
5. Submit a pull request

## 📄 License

This project is licensed under the ISC License.

## ⚠️ Disclaimer

This project is not an official initiative by Sheiling House School. The developers do not own any rights to the Sheiling House logo or branding.

## 👥 Credits

- **Developer**: Ritwik Sharma
- **Idea**: Mayukh Awasthi

## 🐛 Troubleshooting

### Common Issues
1. **Files not loading**: Check Dropbox API credentials and folder structure
2. **Mobile display issues**: Verify CSS media queries
3. **Download links not working**: Ensure Dropbox temporary link generation is working

### Support
For technical issues, please open an issue in the repository or contact the maintainers.

---

Made with ❤️ for Sheiling House School students
