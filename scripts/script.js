subjects = document.querySelectorAll(".subjects");
classes = document.querySelectorAll(".classes");

loadedClass = 0;

function loadSubjects(grade) {
  cSub = "c" + grade;
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
  console.log(grade);
}


function goPapers(subject) {
  document.cookie = `subject=${subject}; path=/; SameSite=Lax; max-age=3600`;
  document.cookie = `loadedClass=${loadedClass}; path=/; SameSite=Lax; max-age=3600`
}

async function fetchDownloadLinks(classs) {
    try {
        const response = await fetch(`/download-links/${classs}`);
        const links = await response.text();
        console.log(links);
    } catch (error) {
        console.error('Error fetching download links:', error);
    }
}

async function fetchPDFLinks(subject) {
    try {
        const response = await fetch(`/list-pdfs/${loadedClass}`);
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        const pdfList = await response.json();
        
        // Log each PDF with local URL
        pdfList.forEach(pdfObj => {
            for (const [filename, _] of Object.entries(pdfObj)) {
                const localUrl = `/pdf/${loadedClass}/${filename}`;
                console.log(`File: ${filename}`);
                console.log(`Local URL: ${localUrl}`);
                console.log('-------------------');
            }
        });
    } catch (error) {
        console.error('Error fetching PDF links:', error);
    }
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
