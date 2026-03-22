// ebayWebhook.js

const express = require('express');
const router = express.Router();

// Verification of eBay notifications
router.get('/webhook', (req, res) => {
    const token = req.query.token;
    // Validate token (eBay sends back the same token you send)
    if (!token || token !== process.env.EBAY_WEBHOOK_TOKEN) {
        return res.status(403).send('Forbidden');
    }
    res.status(200).send('Verified');
});

// Handling eBay notifications
router.post('/webhook', (req, res) => {
    const notification = req.body;
    // Process the notification
    // This example assumes eBay sends back a JSON body
    console.log('Received notification:', notification);

    // Here you can handle different types of notifications
    // Example: Update your listing or evaluate the deal based on the information received

    // Respond to eBay that notification was received
    res.status(200).send('Notification received');
});

module.exports = router;