subjects = document.querySelectorAll(".subjects");
classes = document.querySelectorAll(".classes");

loadedClass = 0;

let userClass = 0;

function loadSubjects(grade) {
    userClass = grade;
    cSub = "c" + grade;
    document.querySelector(`#back`).style.display = "inline-block";
    classes.forEach(classss => {
        classss.style.display = "none"
    })
    subjects.forEach(subject => {
        if ((' ' + subject.className + ' ').indexOf(' ' + cSub + ' ') > -1) {
        subject.style.display = "block";
        } else {
        subject.style.display = "none";
        }
    });
    loadedClass = grade;
}

const left = document.querySelector("#left");

function redirect(link){
    window.open(link, '_blank').focus();
}
let subFiles = 0;
async function fetchFiles(userSubject) {
    const folderPath = `${loadedClass}-Cls`;
    const subjects = document.querySelectorAll(".subjects");
    subjects.forEach(subject => { subject.style.display = "none"; });
    const loader = document.querySelector("#loading");
    loader.style.display = "inline-block";

    try {

        const response = await fetch(`/files?path=${encodeURIComponent(folderPath)}`);
        const files = await response.json();
             
        files.forEach(file => {
            const fileName = file.name.split("()");
            const subject = fileName[0];
            const session = fileName[1];
            const testType = fileName[2];
            const link = file.download_link;
             
             
            if (subject === userSubject) {
                loader.style.display = "none";
                // 'link' is now a server route (/watermarked?id=...) that does not expose the original Dropbox URL
                left.innerHTML += `
                    <div class="papers" onclick="redirect('${link}')">
                        <h3>${testType}</h3>
                        <h4>${session}</h4>
                    </div>
                `;
                subFiles++;
            }
        });
        if (subFiles == 0) {
            loader.style.display = "none";
            left.innerHTML += `<h1 id="noContribution">No Contributions Yet!</h1>`;
        }
        
    } catch (error) {
        console.error("Error fetching files:", error);
    }
    loader.style.display = "none";
}
  

// Example usage: fetchDownloadLinks(9);

/*
function updateCookies() {
    // Update the cookies with the current values of `bg` and `dark`
    document.cookie = `bg=${bg}; path=/; SameSite=Lax; max-age=31536000`; // 1 year
    document.cookie = `dark=${dark}; path=/; SameSite=Lax; max-age=31536000`; // 1 year
    console.log(document.cookie);
}



document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded. Starting initialization...");
    // Your initialization logic here
    const cookies = document.cookie.split('; ');
    console.log("WELCOME")
    for (const cookie of cookies) {
        const [name, value] = cookie.split('=');
        if (name === 'bg') {
            bg = value === 'true';
        } else if (name === 'dark') {
            dark = value === 'true';
        }
    }
*/
