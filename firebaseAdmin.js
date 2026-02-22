const admin = require("firebase-admin");

let serviceAccount;

// Check if running on Railway (with environment variable)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Parse the JSON string from environment variable
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Firebase: Using service account from environment variable");
  } catch (e) {
    console.error("❌ Firebase: Failed to parse FIREBASE_SERVICE_ACCOUNT environment variable");
    console.error("Error details:", e.message);
    throw e;
  }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  // Use path from environment variable (alternative method)
  try {
    serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    console.log("✅ Firebase: Using service account from path:", process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  } catch (e) {
    console.error("❌ Firebase: Failed to load service account from path:", process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    throw e;
  }
} else {
  // Local development - use the default file
  try {
    serviceAccount = require("./serviceAccountKey.json");
    console.log("✅ Firebase: Using local serviceAccountKey.json file");
  } catch (e) {
    console.error("❌ Firebase: serviceAccountKey.json not found and no environment variables set");
    console.error("Please set FIREBASE_SERVICE_ACCOUNT environment variable or add serviceAccountKey.json file");
    throw e;
  }
}

// Initialize Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase Admin initialized successfully");
} catch (e) {
  console.error("❌ Firebase Admin initialization failed:", e.message);
  throw e;
}

const db = admin.firestore();

module.exports = { admin, db };