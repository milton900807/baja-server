

const homeDir = require("os").homedir();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const secretKeyHex = "A4BA8B43795566F988FF8FCBC3016E70";
const byteArray = Buffer.from(secretKeyHex, 'hex');

const iv = createIVFromString('powers'); // 128-bit IV
const ljUsersDir = path.join(homeDir, 'ljusers');


function createIVFromString(inputString) {
    return crypto.createHash('md5').update(inputString).digest(); // 128-bit IV
}

function encodeEmail(email) {
    if (!email) return email;
    const cipher = crypto.createCipheriv('aes-256-cbc', byteArray, iv);
    let encrypted = cipher.update(email, 'utf-8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
}

// Helper to check if a line is an email address
function isEmail(line) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line.trim());
}

// Recursively find all .share files
function findShareFiles(startPath, found = []) {
    if (!fs.existsSync(startPath)) return found;
    const files = fs.readdirSync(startPath);
    for (const file of files) {
        const fullPath = path.join(startPath, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            findShareFiles(fullPath, found);
        } else if (file.endsWith('.share')) {
            found.push(fullPath);
        }
    }
    return found;
}

// Second traversal to match folder names with encoded email
function findFolderByName(startPath, folderName) {
    if (!fs.existsSync(startPath)) return null;
    const files = fs.readdirSync(startPath);
    for (const file of files) {
        const fullPath = path.join(startPath, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            if (file === folderName) return fullPath;
            const found = findFolderByName(fullPath, folderName);
            if (found) return found;
        }
    }
    return null;
}

// Main function
function processShares(rootPath) {
    const shareFiles = findShareFiles(rootPath);

    for (const shareFile of shareFiles) {
        const lines = fs.readFileSync(shareFile, 'utf-8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!isEmail(trimmed)) continue;

            const encoded = encodeEmail(trimmed);
            const targetFolder = findFolderByName(rootPath, encoded);

            if (targetFolder) {
                const sharedWithMeDir = path.join(targetFolder, 'shared_with_me');
                if (!fs.existsSync(sharedWithMeDir)) {
                    fs.mkdirSync(sharedWithMeDir, { recursive: true });
                }

                const filename = path.basename(shareFile) + '.json';
                const destination = path.join(sharedWithMeDir, filename);
                const jsonContent = {
                    sharedFrom: path.dirname(shareFile)
                };

                fs.writeFileSync(destination, JSON.stringify(jsonContent, null, 2), 'utf-8');
                console.log(`Installed share link for ${trimmed} into ${destination}`);
            }
        }
    }
}

const userData =ljUsersDir;
processShares(userData);
