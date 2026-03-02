require('dotenv').config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const axios = require("axios"); // For making calls to actual VSDC/EBM server

// ===============================
// FIREBASE ADMIN SETUP - MODIFIED FOR RAILWAY
// ===============================
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
} else {
  // Local development - use the file
  serviceAccount = require("./serviceAccountKey.json");
  console.log("✅ Firebase: Using local serviceAccountKey.json file");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();

// ===============================
// CORS CONFIGURATION - MODIFIED FOR RAILWAY
// ===============================
const allowedOrigins = [
  'http://localhost:3000',                    // Local React app
  'https://schoolfeedingsystem.web.app',       // Your Firebase frontend
  'https://schoolfeedingsystem.firebaseapp.com', // Alternative Firebase URL
  'https://*.railway.app'                       // Allow Railway domains
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl)
    if (!origin) return callback(null, true);
    
    // Check if origin is allowed
    const isAllowed = allowedOrigins.some(allowed => {
      if (allowed.includes('*')) {
        const pattern = allowed.replace('*', '.*');
        return new RegExp(pattern).test(origin);
      }
      return allowed === origin;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

// ===============================
// VSDC Configuration
// ===============================
const VSDC_CONFIG = {
  // Test environment (sandbox)
  test: {
    ebmApiUrl: process.env.RRA_TEST_URL || "https://sedsandbox.rra.gov.rw",
    vsdcRequestForm: "https://myrrrrest.rra.gov.rw/"
  },
  // Production environment
  production: {
    ebmApiUrl: process.env.RRA_PRODUCTION_URL || "https://api-ebm.rra.gov.rw",
    vsdcRequestForm: "https://myrrra.rra.gov.rw"
  },
  // Current environment (change to 'production' for live)
  currentEnv: process.env.RRA_ENVIRONMENT || "test",
  
  // Default branch ID (00 = head office)
  defaultBhfId: process.env.DEFAULT_BHF_ID || "00"
};

// ===============================
// Code Definitions from VSDC Spec (Section 4)
// ===============================
const CODE_DEFINITIONS = {
  // Tax Type (Section 4.1)
  taxType: {
    A: { name: "A-EX", description: "Tax Exempt", rate: 0 },
    B: { name: "B-18.00%", description: "Standard Rate", rate: 18 },
    C: { name: "C", description: "Zero Rated", rate: 0 },
    D: { name: "D", description: "Other", rate: 0 }
  },
  
  // Product Type (Section 4.3)
  productType: {
    "1": { name: "Raw Material", description: "Raw Material" },
    "2": { name: "Finished Product", description: "Finished Product" },
    "3": { name: "Service", description: "Service without stock" }
  },
  
  // Transaction Type (Section 4.8)
  transactionType: {
    C: { name: "Copy", description: "Copy" },
    N: { name: "Normal", description: "Normal" },
    P: { name: "Proforma", description: "Proforma invoice" },
    T: { name: "Training", description: "Training" }
  },
  
  // Sales Receipt Type (Section 4.9)
  salesReceiptType: {
    S: { name: "Sale", description: "Sale" },
    R: { name: "Refund after Sale", description: "Refund after Sale" }
  },
  
  // Payment Method (Section 4.10)
  paymentMethod: {
    "01": { name: "CASH", description: "CASH" },
    "02": { name: "CREDIT", description: "CREDIT" },
    "03": { name: "CASH/CREDIT", description: "CASH/CREDIT" },
    "04": { name: "BANK CHECK", description: "BANK CHECK PAYMENT" },
    "05": { name: "DEBIT&CREDIT CARD", description: "PAYMENT USING CARD" },
    "06": { name: "MOBILE MONEY", description: "MOBILE MONEY" },
    "07": { name: "OTHER", description: "OTHER MEANS OF PAYMENT" }
  },
  
  // Transaction Progress (Section 4.11)
  transactionProgress: {
    "01": { name: "Wait for Approval", description: "Wait for Approval" },
    "02": { name: "Approved", description: "Approved" },
    "03": { name: "Cancel Requested", description: "Cancel Requested" },
    "04": { name: "Canceled", description: "Canceled" },
    "05": { name: "Refunded", description: "Refunded" },
    "06": { name: "Transferred", description: "Transferred" }
  },
  
  // Registration Type (Section 4.12)
  registrationType: {
    A: { name: "Automatic", description: "Automatic" },
    M: { name: "Manual", description: "Manual" }
  },
  
  // Stock In/Out Type (Section 4.15)
  stockInOutType: {
    "01": { name: "Import", description: "Incoming-Import", direction: "IN" },
    "02": { name: "Purchase", description: "Incoming-Purchase", direction: "IN" },
    "03": { name: "Return", description: "Incoming-Return", direction: "IN" },
    "04": { name: "Stock Movement", description: "Incoming-Stock Movement", direction: "IN" },
    "05": { name: "Processing", description: "Incoming-Processing", direction: "IN" },
    "06": { name: "Adjustment", description: "Incoming-Adjustment", direction: "IN" },
    "11": { name: "Sale", description: "Outgoing-Sale", direction: "OUT" },
    "12": { name: "Return", description: "Outgoing-Return", direction: "OUT" },
    "13": { name: "Stock Movement", description: "Outgoing-Stock Movement", direction: "OUT" },
    "14": { name: "Processing", description: "Outgoing-Processing", direction: "OUT" },
    "15": { name: "Discarding", description: "Outgoing-Discarding", direction: "OUT" },
    "16": { name: "Adjustment", description: "Outgoing-Adjustment", direction: "OUT" }
  },
  
  // Refund Reason Code (Section 4.16)
  refundReasonCode: {
    "01": { name: "Missing Quantity", description: "Missing Quantity" },
    "02": { name: "Missing Item", description: "Missing Item" },
    "03": { name: "Damaged", description: "Damaged" },
    "04": { name: "Wasted", description: "Wasted" },
    "05": { name: "Raw Material Shortage", description: "Raw Material Shortage" },
    "06": { name: "Refund", description: "Refund" },
    "07": { name: "Wrong Customer TIN", description: "Wrong Customer TIN" },
    "08": { name: "Wrong Customer name", description: "Wrong Customer name" },
    "09": { name: "Wrong Amount/price", description: "Wrong Amount/price" },
    "10": { name: "Wrong Quantity", description: "Wrong Quantity" },
    "11": { name: "Wrong Item(s)", description: "Wrong Item(s)" },
    "12": { name: "Wrong tax type", description: "Wrong tax type" },
    "13": { name: "Other reason", description: "Other reason" }
  }
};

// ===============================
// Helper function to generate item code (Section 4.17)
// ===============================
function generateItemCode(orgnNatCd = "RW", itemTyCd = "2", pkgUnitCd = "NT", qtyUnitCd = "U", sequence = null) {
  // Format: Country(2) + ProductType(1) + PackagingUnit(2) + QuantityUnit(2) + Sequence(7)
  // Example: RW2NTU0000012
  if (!sequence) {
    sequence = Math.floor(Math.random() * 10000000).toString().padStart(7, '0');
  }
  return `${orgnNatCd}${itemTyCd}${pkgUnitCd}${qtyUnitCd}${sequence}`;
}

// ===============================
// Helper function to call actual VSDC/EBM API
// ===============================
async function callVsdcApi(endpoint, method = "POST", data = null, token = null) {
  try {
    const baseUrl = VSDC_CONFIG[VSDC_CONFIG.currentEnv].ebmApiUrl;
    const url = `${baseUrl}${endpoint}`;
    
    const headers = {
      "Content-Type": "application/json"
    };
    
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    
    const response = await axios({
      method,
      url,
      data,
      headers,
      timeout: 30000 // 30 seconds timeout
    });
    
    return {
      success: true,
      data: response.data,
      status: response.status
    };
  } catch (error) {
    console.error("VSDC API call failed:", error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data || error.message,
      status: error.response?.status || 500
    };
  }
}

// ===============================
// Firebase token verification middleware
// ===============================
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ 
      resultCd: "401",
      resultMsg: "No token provided",
      error: "No token provided" 
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    console.error("Token verification failed:", error);
    return res.status(401).json({ 
      resultCd: "401",
      resultMsg: "Invalid token",
      error: "Invalid token" 
    });
  }
}

// ===============================
// Test route
// ===============================
app.get("/", (req, res) => {
  res.json({
    service: "VSDC Backend API",
    version: "1.0.4",
    environment: VSDC_CONFIG.currentEnv,
    status: "running",
    documentation: "VSDC Specification v1.0.4 (8th April, 2022)"
  });
});

// ===============================
// ===== VSDC API ENDPOINTS =====
// Based on Section 3.2.1 - List of VSDC functions
// ===============================

// ===============================
// 1. INITIALIZATION - /initializer/selectInitInfo (Section 3.3.1.1)
// ===============================
app.post("/api/vsdc/initializer/selectInitInfo", verifyFirebaseToken, async (req, res) => {
  try {
    const { tin, bhfId, dvcSrNo } = req.body;
    
    // Validate required fields
    if (!tin || !bhfId || !dvcSrNo) {
      return res.status(400).json({
        resultCd: "910",
        resultMsg: "Request parameter error: Missing required fields",
        error: "Missing tin, bhfId, or dvcSrNo"
      });
    }
    
    // Call the actual VSDC API
    const vsdcResponse = await callVsdcApi("/initializer/selectInitInfo", "POST", req.body, req.headers.authorization?.split(" ")[1]);
    
    if (vsdcResponse.success) {
      // Save initialization info to Firestore
      const initRef = db.collection("vsdc_initializations").doc(tin);
      await initRef.set({
        tin,
        bhfId,
        dvcSrNo,
        initializedAt: admin.firestore.FieldValue.serverTimestamp(),
        response: vsdcResponse.data
      }, { merge: true });
      
      return res.json(vsdcResponse.data);
    } else {
      return res.status(vsdcResponse.status || 500).json(vsdcResponse.error);
    }
    
  } catch (error) {
    console.error("Initialization error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 2. CODE MANAGEMENT - /code/selectCodes (Section 3.3.2.1)
// ===============================
app.post("/api/vsdc/code/selectCodes", verifyFirebaseToken, async (req, res) => {
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    // Call the actual VSDC API
    const vsdcResponse = await callVsdcApi("/code/selectCodes", "POST", req.body, req.headers.authorization?.split(" ")[1]);
    
    if (vsdcResponse.success) {
      return res.json(vsdcResponse.data);
    } else {
      return res.status(vsdcResponse.status || 500).json(vsdcResponse.error);
    }
    
  } catch (error) {
    console.error("Code selection error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 3. ITEM CLASSIFICATION - /itemClass/selectItemsClass (Section 3.3.2.2)
// ===============================
app.post("/api/vsdc/itemClass/selectItemsClass", verifyFirebaseToken, async (req, res) => {
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    // Call the actual VSDC API
    const vsdcResponse = await callVsdcApi("/itemClass/selectItemsClass", "POST", req.body, req.headers.authorization?.split(" ")[1]);
    
    if (vsdcResponse.success) {
      return res.json(vsdcResponse.data);
    } else {
      return res.status(vsdcResponse.status || 500).json(vsdcResponse.error);
    }
    
  } catch (error) {
    console.error("Item class selection error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 4. CUSTOMER INFO - /customers/selectCustomer (Section 3.3.2.3)
// ===============================
app.post("/api/vsdc/customers/selectCustomer", verifyFirebaseToken, async (req, res) => {
  try {
    const { tin, bhfId, custmTin } = req.body;
    
    // Call the actual VSDC API
    const vsdcResponse = await callVsdcApi("/customers/selectCustomer", "POST", req.body, req.headers.authorization?.split(" ")[1]);
    
    if (vsdcResponse.success) {
      return res.json(vsdcResponse.data);
    } else {
      return res.status(vsdcResponse.status || 500).json(vsdcResponse.error);
    }
    
  } catch (error) {
    console.error("Customer selection error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 5. BRANCH INFO - /branches/selectBranches (Section 3.3.2.4)
// ===============================
app.post("/api/vsdc/branches/selectBranches", verifyFirebaseToken, async (req, res) => {
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    // Call the actual VSDC API
    const vsdcResponse = await callVsdcApi("/branches/selectBranches", "POST", req.body, req.headers.authorization?.split(" ")[1]);
    
    if (vsdcResponse.success) {
      return res.json(vsdcResponse.data);
    } else {
      return res.status(vsdcResponse.status || 500).json(vsdcResponse.error);
    }
    
  } catch (error) {
    console.error("Branch selection error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 6. ITEM SAVE - /items/saveItems (Section 3.3.4.1)
// This is the endpoint called by your RegisterItem.js
// ===============================
app.post("/api/items", verifyFirebaseToken, async (req, res) => {
  try {
    const data = req.body;
    const sellerUid = req.user.uid;

    // Extract all VSDC fields as per spec
    const {
      adminId,
      districtId,
      schoolId,
      
      // VSDC Required Fields
      tin,
      bhfId,
      itemCd,
      itemClsCd,
      itemTyCd,
      itemNm,
      itemStdNm,
      orgnNatCd,
      pkgUnitCd,
      qtyUnitCd,
      taxTyCd,
      btchNo,
      bcd,
      dftPrc,
      grpPrcL1,
      grpPrcL2,
      grpPrcL3,
      grpPrcL4,
      grpPrcL5,
      addInfo,
      sftyQty,
      isrcAplcbYn,
      useYn,
      
      // Registrant info
      regrNm,
      regrId,
      modrNm,
      modrId,
      
      // Local stock
      quantity
    } = data;

    // Validate required fields (as per spec)
    const requiredFields = {
      tin, bhfId, itemCd, itemClsCd, itemTyCd, itemNm,
      orgnNatCd, pkgUnitCd, qtyUnitCd, taxTyCd, dftPrc,
      isrcAplcbYn, useYn, regrNm, regrId, modrNm, modrId
    };

    const missingFields = Object.entries(requiredFields)
      .filter(([_, value]) => !value && value !== 0)
      .map(([key]) => key);

    if (missingFields.length > 0) {
      return res.status(400).json({
        resultCd: "910",
        resultMsg: "Request parameter error",
        error: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    // Generate item code if not provided (Section 4.17)
    const finalItemCd = itemCd || generateItemCode(orgnNatCd, itemTyCd, pkgUnitCd, qtyUnitCd);

    // Save to Firestore
    const inventoryRef = db
      .collection("admin")
      .doc(adminId)
      .collection("district")
      .doc(districtId)
      .collection("school")
      .doc(schoolId)
      .collection("inventory")
      .doc(finalItemCd);

    const itemDoc = {
      // VSDC Item Master fields (matching spec)
      tin,
      bhfId: bhfId || "00",
      
      itemCd: finalItemCd,
      itemClsCd,
      itemTyCd,
      itemNm,
      itemStdNm: itemStdNm || null,
      
      orgnNatCd: orgnNatCd || "RW",
      pkgUnitCd,
      qtyUnitCd,
      taxTyCd: taxTyCd || "B",
      
      btchNo: btchNo || null,
      bcd: bcd || null,
      
      dftPrc: Number(dftPrc),
      
      grpPrcL1: grpPrcL1 !== undefined && grpPrcL1 !== "" ? Number(grpPrcL1) : null,
      grpPrcL2: grpPrcL2 !== undefined && grpPrcL2 !== "" ? Number(grpPrcL2) : null,
      grpPrcL3: grpPrcL3 !== undefined && grpPrcL3 !== "" ? Number(grpPrcL3) : null,
      grpPrcL4: grpPrcL4 !== undefined && grpPrcL4 !== "" ? Number(grpPrcL4) : null,
      grpPrcL5: grpPrcL5 !== undefined && grpPrcL5 !== "" ? Number(grpPrcL5) : null,
      
      addInfo: addInfo || null,
      sftyQty: sftyQty !== undefined && sftyQty !== "" ? Number(sftyQty) : null,
      
      isrcAplcbYn: isrcAplcbYn || "N",
      useYn: useYn || "Y",
      
      // Registrant info
      regrNm,
      regrId,
      modrNm,
      modrId,
      
      // Local stock
      quantity: quantity !== undefined ? Number(quantity) : 0,
      
      // VSDC sync control
      vsdcSynced: false,
      vsdcLastResult: null,
      vsdcSyncAttempts: 0,
      
      // Metadata
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: sellerUid
    };

    await inventoryRef.set(itemDoc, { merge: true });

    // Also save to VSDC items collection for tracking
    const vsdcItemRef = db
      .collection("vsdc_items")
      .doc(finalItemCd);
    
    await vsdcItemRef.set({
      ...itemDoc,
      syncedToEbm: false,
      lastSyncAttempt: null
    }, { merge: true });

    // Call the actual VSDC API to save the item
    const vsdcResponse = await callVsdcApi("/items/saveItems", "POST", {
      tin,
      bhfId: bhfId || "00",
      itemCd: finalItemCd,
      itemClsCd,
      itemTyCd,
      itemNm,
      itemStdNm: itemStdNm || null,
      orgnNatCd: orgnNatCd || "RW",
      pkgUnitCd,
      qtyUnitCd,
      taxTyCd: taxTyCd || "B",
      btchNo: btchNo || null,
      bcd: bcd || null,
      dftPrc: Number(dftPrc),
      grpPrcL1: grpPrcL1 !== undefined && grpPrcL1 !== "" ? Number(grpPrcL1) : null,
      grpPrcL2: grpPrcL2 !== undefined && grpPrcL2 !== "" ? Number(grpPrcL2) : null,
      grpPrcL3: grpPrcL3 !== undefined && grpPrcL3 !== "" ? Number(grpPrcL3) : null,
      grpPrcL4: grpPrcL4 !== undefined && grpPrcL4 !== "" ? Number(grpPrcL4) : null,
      grpPrcL5: grpPrcL5 !== undefined && grpPrcL5 !== "" ? Number(grpPrcL5) : null,
      addInfo: addInfo || null,
      sftyQty: sftyQty !== undefined && sftyQty !== "" ? Number(sftyQty) : null,
      isrcAplcbYn: isrcAplcbYn || "N",
      useYn: useYn || "Y",
      regrNm,
      regrId,
      modrNm,
      modrId
    }, req.headers.authorization?.split(" ")[1]);

    // Update sync status
    if (vsdcResponse.success) {
      await vsdcItemRef.update({
        vsdcSynced: true,
        vsdcLastResult: vsdcResponse.data,
        lastSyncAttempt: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      await vsdcItemRef.update({
        vsdcSynced: false,
        vsdcLastResult: vsdcResponse.error,
        vsdcSyncAttempts: admin.firestore.FieldValue.increment(1),
        lastSyncAttempt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return res.json({
      resultCd: "000",
      resultMsg: "It is succeeded",
      resultDt: new Date().toISOString().replace(/[-:]/g, "").slice(0, 14),
      data: {
        itemId: finalItemCd,
        message: "Item saved successfully and synced to VSDC",
        vsdcResponse: vsdcResponse.success ? vsdcResponse.data : null
      }
    });

  } catch (error) {
    console.error("Save item error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 7. ITEM SELECT - /items/selectItems (Section 3.3.4.2)
// ===============================
app.post("/api/vsdc/items/selectItems", verifyFirebaseToken, async (req, res) => {
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    // Call the actual VSDC API
    const vsdcResponse = await callVsdcApi("/items/selectItems", "POST", req.body, req.headers.authorization?.split(" ")[1]);
    
    if (vsdcResponse.success) {
      return res.json(vsdcResponse.data);
    } else {
      return res.status(vsdcResponse.status || 500).json(vsdcResponse.error);
    }
    
  } catch (error) {
    console.error("Item selection error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 8. SALES TRANSACTION SAVE - /trnsSales/saveSales (Section 3.3.6.1)
// ===============================
app.post("/api/vsdc/trnsSales/saveSales", verifyFirebaseToken, async (req, res) => {
  try {
    const salesData = req.body;
    const sellerUid = req.user.uid;
    
    const {
      tin,
      bhfId,
      invcNo,
      orgInvcNo,
      custTin,
      custNm,
      salesTyCd,
      rcptTyCd,
      pmtTyCd,
      salesSttsCd,
      cfmDt,
      salesDt,
      totItemCnt,
      taxblAmtA,
      taxblAmtB,
      taxblAmtC,
      taxblAmtD,
      taxRtA,
      taxRtB,
      taxRtC,
      taxRtD,
      taxAmtA,
      taxAmtB,
      taxAmtC,
      taxAmtD,
      totTaxblAmt,
      totTaxAmt,
      totAmt,
      itemList,
      receipt
    } = salesData;
    
    // Validate required fields
    if (!tin || !bhfId || !invcNo || !itemList || itemList.length === 0) {
      return res.status(400).json({
        resultCd: "910",
        resultMsg: "Request parameter error",
        error: "Missing required sales fields"
      });
    }
    
    // Call the actual VSDC API
    const vsdcResponse = await callVsdcApi("/trnsSales/saveSales", "POST", req.body, req.headers.authorization?.split(" ")[1]);
    
    if (!vsdcResponse.success) {
      return res.status(vsdcResponse.status || 500).json(vsdcResponse.error);
    }
    
    // Save sales transaction to Firestore
    const salesRef = db.collection("vsdc_sales").doc();
    await salesRef.set({
      ...salesData,
      ...vsdcResponse.data,
      sellerUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return res.json(vsdcResponse.data);
    
  } catch (error) {
    console.error("Save sales error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 9. STOCK IN/OUT SAVE - /stock/saveStockItems (Section 3.3.8.2)
// ===============================
app.post("/api/vsdc/stock/saveStockItems", verifyFirebaseToken, async (req, res) => {
  try {
    const stockData = req.body;
    
    const {
      tin,
      bhfId,
      sarNo,
      orgSarNo,
      regTyCd,
      custTin,
      custNm,
      sarTyCd,
      ocrnDt,
      totItemCnt,
      totTaxblAmt,
      totTaxAmt,
      totAmt,
      itemList
    } = stockData;
    
    // Validate
    if (!tin || !bhfId || !sarNo || !sarTyCd || !itemList) {
      return res.status(400).json({
        resultCd: "910",
        resultMsg: "Request parameter error",
        error: "Missing required stock fields"
      });
    }
    
    // Call the actual VSDC API
    const vsdcResponse = await callVsdcApi("/stock/saveStockItems", "POST", req.body, req.headers.authorization?.split(" ")[1]);
    
    if (!vsdcResponse.success) {
      return res.status(vsdcResponse.status || 500).json(vsdcResponse.error);
    }
    
    // Save stock movement record
    const stockRef = db.collection("vsdc_stock_movements").doc();
    await stockRef.set({
      ...stockData,
      vsdcResponse: vsdcResponse.data,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return res.json(vsdcResponse.data);
    
  } catch (error) {
    console.error("Save stock error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 10. STOCK MASTER SAVE - /stockMaster/saveStockMaster (Section 3.3.8.3)
// ===============================
app.post("/api/vsdc/stockMaster/saveStockMaster", verifyFirebaseToken, async (req, res) => {
  try {
    const { tin, bhfId, itemCd, rsdQty, regrNm, regrId } = req.body;
    
    if (!tin || !bhfId || !itemCd || rsdQty === undefined) {
      return res.status(400).json({
        resultCd: "910",
        resultMsg: "Request parameter error",
        error: "Missing required stock master fields"
      });
    }
    
    // Call the actual VSDC API
    const vsdcResponse = await callVsdcApi("/stockMaster/saveStockMaster", "POST", req.body, req.headers.authorization?.split(" ")[1]);
    
    if (vsdcResponse.success) {
      return res.json(vsdcResponse.data);
    } else {
      return res.status(vsdcResponse.status || 500).json(vsdcResponse.error);
    }
    
  } catch (error) {
    console.error("Save stock master error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 11. SYNC ITEM TO EBM (Manual trigger)
// ===============================
app.post("/api/vsdc/sync-item/:itemCd", verifyFirebaseToken, async (req, res) => {
  try {
    const { itemCd } = req.params;
    const { tin, bhfId } = req.body;
    
    // Get item from Firestore
    const itemRef = db.collection("vsdc_items").doc(itemCd);
    const itemDoc = await itemRef.get();
    
    if (!itemDoc.exists) {
      return res.status(404).json({
        resultCd: "995",
        resultMsg: "Item not found",
        error: "Item not found"
      });
    }
    
    const itemData = itemDoc.data();
    
    // Call VSDC API to sync
    const vsdcResponse = await callVsdcApi("/items/saveItems", "POST", {
      tin: itemData.tin,
      bhfId: itemData.bhfId,
      itemCd: itemData.itemCd,
      itemClsCd: itemData.itemClsCd,
      itemTyCd: itemData.itemTyCd,
      itemNm: itemData.itemNm,
      itemStdNm: itemData.itemStdNm,
      orgnNatCd: itemData.orgnNatCd,
      pkgUnitCd: itemData.pkgUnitCd,
      qtyUnitCd: itemData.qtyUnitCd,
      taxTyCd: itemData.taxTyCd,
      btchNo: itemData.btchNo,
      bcd: itemData.bcd,
      dftPrc: itemData.dftPrc,
      grpPrcL1: itemData.grpPrcL1,
      grpPrcL2: itemData.grpPrcL2,
      grpPrcL3: itemData.grpPrcL3,
      grpPrcL4: itemData.grpPrcL4,
      grpPrcL5: itemData.grpPrcL5,
      addInfo: itemData.addInfo,
      sftyQty: itemData.sftyQty,
      isrcAplcbYn: itemData.isrcAplcbYn,
      useYn: itemData.useYn,
      regrNm: itemData.regrNm,
      regrId: itemData.regrId,
      modrNm: itemData.modrNm,
      modrId: itemData.modrId
    }, req.headers.authorization?.split(" ")[1]);
    
    // Update sync status
    await itemRef.update({
      vsdcSynced: vsdcResponse.success,
      vsdcLastResult: vsdcResponse,
      vsdcSyncAttempts: admin.firestore.FieldValue.increment(1),
      lastSyncAttempt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    if (vsdcResponse.success) {
      return res.json({
        resultCd: "000",
        resultMsg: "Item synced successfully to EBM",
        data: vsdcResponse.data
      });
    } else {
      return res.status(500).json({
        resultCd: "999",
        resultMsg: "Failed to sync to EBM",
        error: vsdcResponse.error
      });
    }
    
  } catch (error) {
    console.error("Sync item error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 12. GET CODE DEFINITIONS (Helper for frontend)
// ===============================
app.get("/api/vsdc/codes", verifyFirebaseToken, async (req, res) => {
  try {
    return res.json({
      resultCd: "000",
      resultMsg: "It is succeeded",
      data: CODE_DEFINITIONS
    });
  } catch (error) {
    console.error("Get codes error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 13. GENERATE ITEM CODE (Helper)
// ===============================
app.post("/api/vsdc/generate-item-code", verifyFirebaseToken, async (req, res) => {
  try {
    const { orgnNatCd, itemTyCd, pkgUnitCd, qtyUnitCd } = req.body;
    
    const itemCode = generateItemCode(
      orgnNatCd || "RW",
      itemTyCd || "2",
      pkgUnitCd || "NT",
      qtyUnitCd || "U"
    );
    
    return res.json({
      resultCd: "000",
      resultMsg: "Item code generated",
      data: {
        itemCode,
        format: "Country(2) + ProductType(1) + PackagingUnit(2) + QuantityUnit(2) + Sequence(7)"
      }
    });
    
  } catch (error) {
    console.error("Generate item code error:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 14. GET LAST INVOICE NUMBER - ADDED MISSING ENDPOINT
// ===============================
app.get("/api/vsdc/last-invoice/:tin", verifyFirebaseToken, async (req, res) => {
  try {
    const { tin } = req.params;
    const { bhfId } = req.query;
    
    // Query Firestore for the last invoice for this seller
    const salesRef = db.collection("vsdc_sales");
    const snapshot = await salesRef.where("tin", "==", tin).orderBy("invcNo", "desc").limit(1).get();
    
    let lastInvoiceNo = 0;
    let lastReceiptNo = 0;
    
    if (!snapshot.empty) {
      const lastSale = snapshot.docs[0].data();
      lastInvoiceNo = lastSale.invcNo || 0;
      lastReceiptNo = lastSale.rcptNo || 0;
    }
    
    return res.json({
      resultCd: "000",
      resultMsg: "It is succeeded",
      resultDt: new Date().toISOString().replace(/[-:]/g, "").slice(0, 14),
      data: {
        lastSaleInvcNo: lastInvoiceNo,
        lastSaleRcptNo: lastReceiptNo,
        lastPchsInvcNo: 0,
        lastInvcNo: null,
        lastTrainInvcNo: null,
        lastProfrmInvcNo: null,
        lastCopyInvcNo: null
      }
    });
    
  } catch (error) {
    console.error("Error fetching last invoice:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// 15. GET DEVICE INFO - ADDED MISSING ENDPOINT
// ===============================
app.get("/api/vsdc/device-info/:tin", verifyFirebaseToken, async (req, res) => {
  try {
    const { tin } = req.params;
    
    // Get device initialization info from Firestore
    const initRef = db.collection("vsdc_initializations").doc(tin);
    const initDoc = await initRef.get();
    
    if (!initDoc.exists) {
      return res.status(404).json({
        resultCd: "995",
        resultMsg: "Device not initialized",
        error: "Device not initialized for this TIN"
      });
    }
    
    const initData = initDoc.data();
    
    return res.json({
      resultCd: "000",
      resultMsg: "It is succeeded",
      resultDt: new Date().toISOString().replace(/[-:]/g, "").slice(0, 14),
      data: {
        initialized: true,
        initializedAt: initData.initializedAt,
        tin: initData.tin,
        bhfId: initData.bhfId,
        dvcSrNo: initData.dvcSrNo
      }
    });
    
  } catch (error) {
    console.error("Error fetching device info:", error);
    return res.status(500).json({
      resultCd: "999",
      resultMsg: "Unknown server error",
      error: error.message
    });
  }
});

// ===============================
// Legacy endpoint for backward compatibility
// ===============================
app.post("/api/invoice", verifyFirebaseToken, async (req, res) => {
  try {
    const sellerUid = req.user.uid;
    const invoiceData = req.body;

    const {
      adminId,
      districtId,
      schoolId,
      buyer
    } = invoiceData;

    const buyerName = buyer?.name || null;
    const buyerTinNumber = buyer?.tin || null;
    const buyerPhone = buyer?.phone || null;

    if (!adminId || !districtId || !schoolId) {
      return res.status(400).json({
        error: "Missing adminId, districtId or schoolId"
      });
    }

    console.log("Invoice received from user:", sellerUid);

    const salesRef = db
      .collection("admin")
      .doc(adminId)
      .collection("district")
      .doc(districtId)
      .collection("school")
      .doc(schoolId)
      .collection("seller")
      .doc(sellerUid)
      .collection("sales");

    const savedDoc = await salesRef.add({
      ...invoiceData,
      buyerName,
      buyerTinNumber,
      buyerPhone,
      sellerUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({
      success: true,
      sellerUid,
      saleId: savedDoc.id,
      message: "Invoice saved successfully"
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
});

// ===============================
// Health check endpoint
// ===============================
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: VSDC_CONFIG.currentEnv,
    vsdcApiUrl: VSDC_CONFIG[VSDC_CONFIG.currentEnv].ebmApiUrl
  });
});

// ===============================
// Start server - MODIFIED FOR RAILWAY
// ===============================
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log("=".repeat(50));
  console.log(`✅ VSDC Backend Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${VSDC_CONFIG.currentEnv}`);
  console.log(`🔗 EBM API URL: ${VSDC_CONFIG[VSDC_CONFIG.currentEnv].ebmApiUrl}`);
  console.log("=".repeat(50));
});