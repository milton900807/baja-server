const axios = require('axios');
const fs = require('fs');
const path = require('path');

// PAYPAL_CLIENT_ID=AWCcwTFsL_ITGceNXKptRX_tpNxMtnLFQTUK9xZtCkGz05j2Zxp0ifOfel4vcNg890MM9Msm3bDBzsZQ
// PAYPAL_SECRET=EPxHXyqZ3-E-8HpaeFcT6r_zav-1qBYqTPdPna9_AmEFXLubyzXAL7w2qWpy0s-mMYvSsvtjs2nv7kZy
// PAYPAL_API_BASE=https://sandbox.paypal.com

// Function to get PayPal access token
async function getPayPalAccessToken(clientId, clientSecret) {
    const tokenUrl = 'https://api.paypal.com/v1/oauth2/token';
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await axios.post(tokenUrl, 'grant_type=client_credentials', {
        headers: {
            Authorization: `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    });

    return response.data.access_token;
}

// Function to get subscribers for a product
async function getSubscribers(productId, accessToken) {
    const url = `https://api.paypal.com/v1/billing/subscriptions`;
    const subscribers = [];
    let nextPageUrl = `${url}?product_id=${productId}`;

    while (nextPageUrl) {
        const response = await axios.get(nextPageUrl, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });

        subscribers.push(...response.data.subscriptions);
        nextPageUrl = response.data.links?.find(link => link.rel === 'next')?.href || null;
    }

    return subscribers;
}

// Function to save subscribers to a JSON file
function saveSubscribersToFile(subscribers, fileName = 'subscribers.json') {
    const filePath = path.join(__dirname, fileName);
    fs.writeFileSync(filePath, JSON.stringify(subscribers, null, 2));
    console.log(`Subscribers saved to ${filePath}`);
}

// Main function to handle everything
async function downloadSubscribers(productId, clientId, clientSecret) {
    try {
        const accessToken = await getPayPalAccessToken(clientId, clientSecret);
        const subscribers = await getSubscribers(productId, accessToken);
        saveSubscribersToFile(subscribers);
    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
    }
}

// Usage
const clientId = 'AcA82vE_BhndxEGuihZFYnkERvXTnzL5LwazJIY4zKTWuVKpYVDyPa_FH2dUfP3mcFxk267pMslPtUio';
const clientSecret = 'AcA82vE_BhndxEGuihZFYnkERvXTnzL5LwazJIY4zKTWuVKpYVDyPa_FH2dUfP3mcFxk267pMslPtUio';
const productId = 'PROD-1X668134R04268044';

downloadSubscribers(productId, clientId, clientSecret);
