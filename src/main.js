import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './style.css';
import App from './App.vue';
import { router } from './router/index.js';
import { formsLibrary, seedSystemForms } from './data/collections/formsLibrary.js';
import { formData } from './data/collections/formData.js';
import { chatThreads } from './data/collections/chatThreads.js';
import {
  encounterLogs, encounterStage, encounterConsent, prescriptions,
  encounterImages, encounterAnnotations, careTeam,
} from './data/collections/encounterDocs.js';
import { users } from './data/collections/users.js';
import { publicAppointments } from './data/collections/publicAppointments.js';
import { aiEnginePatients } from './data/collections/aiEnginePatients.js';
import { aiEngineStaff } from './data/collections/aiEngineStaff.js';
import { aiEngineEncounters } from './data/collections/aiEngineEncounters.js';
import { API_BASE } from './config.js';
import { useAuthStore } from './stores/auth.js';

// TanStack DB collections load their persisted data asynchronously (even the localStorage-backed
// ones — see collection.preload()'s own doc comment: "useful for preloading collections"), not
// synchronously at creation. Several components read collections synchronously at component-
// setup time (e.g. ConsultationDesk.vue's `const encounter = clinical.getEncounter()`), which
// raced and returned stale/empty data on a hard page load before this fix — preload everything
// before the router/app ever mounts so every synchronous read anywhere in the app is guaranteed
// to see already-hydrated data.
const collections = [
  formsLibrary, formData, chatThreads, users, publicAppointments,
  encounterLogs, encounterStage, encounterConsent, prescriptions, encounterImages, encounterAnnotations, careTeam,
  aiEnginePatients, aiEngineStaff, aiEngineEncounters,
];

await Promise.all(collections.map((c) => c.preload()));

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');

// Revalidates a stored session against the server on every app load — picks up a tier change
// (free -> paid) since last login without forcing a fresh login, and silently logs out if the
// token's no longer valid.
useAuthStore().refreshSession();

// clinuxflow-api may not be running (e.g. local dev without `wrangler dev` started in that
// project) — same tolerance clinixflow's seedSystemForms had for a missing server, just also
// covering a full network failure (connection refused), not only a non-success response body.
seedSystemForms(API_BASE).catch((err) => {
  console.warn('Could not reach clinuxflow-api to seed the system forms catalog:', err.message);
});


//To get a short, API-key-like string that can be perfectly reversed back into your 5KB JSON, 
// use one of the following methods.
//Pack the 5KB of data directly into the string, you can use AES encryption combined with Hex encoding.
// Format: A long string of hexadecimal characters (0-9, a-f) or modified Base64 that looks like a cryptographic key.
// How it works:
// 1. Compress the JSON using GZIP (to reduce the 5KB size).
// 2. Encrypt it with an AES-256 key.
// 3. Encode the output using standard Hex or Base58 (which removes confusing characters like +, /, and =).
// Pros: 100% reversible without a database, and the data is completely secure.
// Key highlights of this approach:
// Built-in Security: AES-GCM provides authenticated encryption. If anyone modifies even a single letter of the key string, 
// the decryption will safely fail instead of outputting corrupted data.
// Size Reduction: The CompressionStream("gzip") line ensures your 5KB JSON is packed tightly, keeping the final 
// generated string as short as possible.
// No Dependencies: Runs natively in runtime environments like Node.js, Cloudflare Workers, Deno, and standard 
// web browsers without needing external npm libraries.

// Supported features
// Do you require the final key string to stay below a specific character length limit? Yes
// Do you want to see how to add a timestamp check inside the key so it automatically expires after a certain amount of time? Yes
// Do you need assistance mapping out how to rotate or change the HEX_SECRET_KEY safely over time? Yes

// The KEY_REGISTRY object prevents system outages when updating secrets. 
// If you change your encryption key instantly, all existing QR codes out in the wild will immediately break.
// To prevent this, use this 3-step timeline to rotate your keys safely:

// [Phase 1: Normal]     -> KEY_REGISTRY has "v1" (Active)
//                          System encrypts and decrypts with "v1".

// [Phase 2: Transition] -> KEY_REGISTRY has "v2" (Active) AND "v1" (Old)
//                          - New keys/QR codes are generated using "v2".
//                          - Old QR codes scanned by users are cleanly decrypted using "v1".

// [Phase 3: Cleanup]    -> After 24-48 hours (when all "v1" keys have naturally expired via timestamp),
//                          remove "v1" from the code completely.

// 1. Generate or define a persistent 256-bit (32-byte) master key.
// In production, keep this string secret and secure!
// A dictionary of valid secret keys to support safe rotation. 
// The system uses 'active' to encrypt, but can decrypt using 'old' keys.
const KEY_REGISTRY = {
  "v2": "1111111111111111111111111111111111111111111111111111111111111111", // Active Key
  "v1": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"  // Old Key
};
const ACTIVE_KEY_VERSION = "v2"; 
const MAX_ALLOWED_CHARACTERS = 2000; // Define your strict limit here

// Helper: Import a hex string into a native CryptoKey object
async function getCryptoKey(hexString) {
  const rawKey = new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
  return await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// Helper: Convert Uint8Array to URL-safe Base64 without padding (Saves characters!)
function bytesToBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Helper: Convert URL-safe Base64 back to Uint8Array
function base64UrlToBytes(base64Url) {
  let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return new Uint8Array(atob(base64).split('').map(c => c.charCodeAt(0)));
}

/**
 * Encodes JSON + Expiration timestamp into a short, secure key string.
 * @param {Object} jsonObject - The 5KB payload.
 * @param {number} ttlMilliseconds - How long the key remains valid (e.g., 3600000 for 1 hour).
 */
async function jsonToKey(jsonObject, ttlMilliseconds = 86400000) { // Default: 24 hours
  // 1. Pack data along with an absolute expiration timestamp
  const expirationTimestamp = Date.now() + ttlMilliseconds;
  const wrappedPayload = {
    exp: expirationTimestamp,
    data: jsonObject
  };

  // 2. Compress the string using GZIP
  const jsonString = JSON.stringify(wrappedPayload);
  const stream = new Response(jsonString).body.pipeThrough(new CompressionStream("gzip"));
  const compressedBytes = new Uint8Array(await new Response(stream).arrayBuffer());

  // 3. Encrypt using AES-GCM
  const key = await getCryptoKey(KEY_REGISTRY[ACTIVE_KEY_VERSION]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, compressedBytes));

  // 4. Build binary packet: [IV (12B)] + [Ciphertext (Variable)]
  const combinedPayload = new Uint8Array(iv.length + ciphertextBytes.length);
  combinedPayload.set(iv, 0);
  combinedPayload.set(ciphertextBytes, iv.length);

  // 5. Convert to Base64URL and attach prefix + Key Version indicator
  const encodedData = bytesToBase64Url(combinedPayload);
  const finalKey = `sk_${ACTIVE_KEY_VERSION}_${encodedData}`;

  // 6. ENFORCE STRICT CHARACTER LIMIT
  if (finalKey.length > MAX_ALLOWED_CHARACTERS) {
    throw new Error(`Key generation blocked! String length (${finalKey.length}) exceeds strict limit of ${MAX_ALLOWED_CHARACTERS} chars.`);
  }

  return finalKey;
}

/**
 * Decodes the key string and enforces timestamp verification and key rotation logic.
 */
async function keyToJson(keyString) {
  try {
    // 1. Parse the prefix and key version from the string
    const parts = keyString.split("_");
    if (parts.length !== 3 || parts[0] !== "sk") throw new Error("Invalid key format structure");
    
    const keyVersion = parts[1];
    const encodedData = parts[2];

    // 2. Check if the key was encrypted with a version we still recognize
    const hexKeyString = KEY_REGISTRY[keyVersion];
    if (!hexKeyString) throw new Error(`Expired Key Secret: Version '${keyVersion}' has been fully phased out`);

    // 3. Convert Base64URL back to bytes and extract IV vs Ciphertext
    const combinedPayload = base64UrlToBytes(encodedData);
    const iv = combinedPayload.slice(0, 12);
    const ciphertextBytes = combinedPayload.slice(12);

    // 4. Decrypt
    const key = await getCryptoKey(hexKeyString);
    const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertextBytes);

    // 5. Decompress GZIP
    const stream = new Response(decryptedBuffer).body.pipeThrough(new DecompressionStream("gzip"));
    const unwrappedPayload = JSON.parse(await new Response(stream).text());

    // 6. ENFORCE TIMESTAMP EXPIRATION
    if (Date.now() > unwrappedPayload.exp) {
      throw new Error("Security block: This key has expired!");
    }

    return unwrappedPayload.data;
  } catch (error) {
    // Graceful error handling instead of app-crashing
    return { success: false, error: error.message };
  }
}

// --- Example Usage ---
async function runTest() {
  const complexData = { name: "Alice", scope: "admin", data: "X".repeat(3000) }; // Simulate ~3KB data
  
  console.log("--- 1. Generating valid key (Expires in 5 seconds) ---");
  const validKey = await jsonToKey(complexData, 5000); 
  console.log(`Key Generated (${validKey.length} chars):`, validKey.substring(0, 60) + "...");

  console.log("\n--- 2. Scanning Key Immediately ---");
  const immediateScan = await keyToJson(validKey);
  console.log("Scan Status: Success!", !!immediateScan.name);

  console.log("\n--- 3. Waiting 6 seconds for key to expire... ---");
  await new Promise(resolve => setTimeout(resolve, 6000));

  console.log("--- 4. Scanning Key After Waiting ---");
  const expiredScan = await keyToJson(validKey);
  console.log("Scan Result:", expiredScan); 
  // Output: { success: false, error: "Security block: This key has expired!" }
}

// Generating a QR code for the API key can be done using a library like 'qrcode' in Node.js. 
// Below is an example of how to generate a QR code from the API key string.


// Install library first: npm install qrcode
// const QRCode = require('qrcode');

// async function generateQR(apiKey) {
//   try {
//     // Generates a Data URL (base64 image) you can display in an <img> tag
//     const qrCodeDataUrl = await QRCode.toDataURL(apiKey, {
//       errorCorrectionLevel: 'L', // Low error correction leaves more room for data
//       margin: 2,
//       width: 400
//     });
//     console.log("QR Code Generated successfully!");
//     return qrCodeDataUrl;
//   } catch (err) {
//     console.error("Failed to generate QR code. String might be too long:", err);
//   }
// }

// The length of the generated key will strictly depend on how repetitive your JSON data is, 
// but it will typically fall between 350 and 3,500 characters.
// Because the JavaScript code compresses the data using GZIP before turning it into a key, 
// the final character count is decided entirely by your data's compression ratio.
// ## Expected Length Breakdowns

// * 
// * ~350 to 800 characters (Best Case - Highly Repetitive Data): 
// If your 5KB JSON consists of a long array of similar objects, predictable keys, 
// or repeated text values (like a massive list of user logs), GZIP will shrink it drastically to under 300 bytes. 
// The final Hex key will be very short.
// * ~1,200 to 2,500 characters (Average Case - Standard JSON): If your JSON contains a normal mix of unique keys, 
// text descriptions, numbers, and diverse nested structures, it usually compresses by about 60–70%.
// * ~3,500 to 4,200 characters (Worst Case - Low Repetition Data): If your JSON contains data that cannot be compressed 
// well—such as pre-encrypted text, heavy mathematical data, or completely random hashes—GZIP won't be able to shrink it much.
// * 

// ------------------------------
// ## Exact Mathematical Formula Used by the Code
// If you want to calculate the exact character length for a specific JSON object, 
// the mathematical breakdown for the hex key string is:
// $$\text{Key Length} = 8 + 2 \times (\text{Compressed Bytes} + 28)$$ 

// * 
// * 8 characters for the prefix (sk_live_).
// * 28 additional bytes for security components (12 bytes for the IV + 16 bytes for the AES-GCM Auth Tag).
// * 2 characters multiplied per byte because Hex encoding takes up exactly 2 text characters per byte of data. [1] 
// * 

// ------------------------------
// ## What this means for your QR Code

// * 
// * If your key lands in the Best/Average case (under 2,000 characters), 
// it will fit reliably inside a standard Version 30 to 35 QR Code. 
// Most modern smartphones will scan this easily if printed cleanly.
// * If your key lands in the Worst case (over 3,000 characters), 
// it will push the absolute upper boundary of QR code data limits (4,296 characters), 
// making it nearly impossible to scan reliably in the real world.
// * 

// If you want a quick script to measure your exact JSON compression size, or 
// if we should pivot to the short-token database approach to guarantee a tiny, fixed-length key.

// import json
// import zlib
// import base64

// # Simulate a 5KB JSON payload
// # Let's create a dictionary and blow it up to roughly 5120 
// charactersbase_data = {"id": 1024, "name": "Avery Smith", 
//      "role": "Senior Cloud Infrastructure Engineer", 
//      "active": True, "tags": ["prod", "aws", "security"]}
// payload = []
// current_size = 0
// while current_size < 5120:
//     payload.append(base_data)
//     current_size = len(json.dumps(payload))
// json_str = json.dumps(payload)
// json_len = len(json_str)
// # 1. Compress
// compressed = zlib.compress(json_str.encode('utf-8'))
// comp_len = len(compressed)

// # 2. Add IV (12 bytes) and Auth Tag (16 bytes) -> Total 28 bytes added to ciphertext
// # Note: AES-GCM ciphertext length equals plaintext length
// raw_payload_len = 12 + 16 + comp_len

// # 3. Hex string length (each byte becomes 2 hex characters)
// # Plus prefix 'sk_live_' (8 characters)
// hex_key_len = 8 + (raw_payload_len * 2)

// print(f"Original JSON size: {json_len} bytes")
// print(f"Compressed size: {comp_len} bytes")
// print(f"Hex Key Length: {hex_key_len} characters")

/**
 * Measures the exact compressed byte size and the final generated key length
 * for any given JavaScript object or 5KB JSON.
 */
async function measureJsonKeyLength(jsonObject) {
  const jsonString = JSON.stringify(jsonObject);
  const originalByteSize = new TextEncoder().encode(jsonString).length;

  // 1. Run through GZIP compression stream
  const stream = new Response(jsonString).body.pipeThrough(new CompressionStream("gzip"));
  const compressedBuffer = await new Response(stream).arrayBuffer();
  const compressedByteSize = compressedBuffer.byteLength;

  // 2. Add security overhead (12 bytes IV + 16 bytes Auth Tag)
  const totalEncryptedBytes = compressedByteSize + 28;

  // 3. Hex encoding multiplies bytes by 2, plus 8 characters for "sk_live_"
  const finalKeyLength = 8 + (totalEncryptedBytes * 2);

  // Print results
  console.log("=== JSON SIZE ANALYZER ===");
  console.log(`Original JSON Size:    ${(originalByteSize / 1024).toFixed(2)} KB (${originalByteSize} bytes)`);
  console.log(`GZIP Compressed Size: ${(compressedByteSize / 1024).toFixed(2)} KB (${compressedByteSize} bytes)`);
  console.log(`Compression Ratio:     ${((1 - compressedByteSize / originalByteSize) * 100).toFixed(1)}% shrunk`);
  console.log("--------------------------");
  console.log(`Final API Key Length:  ${finalKeyLength} characters`);
  
  if (finalKeyLength > 2953) {
    console.warn("⚠️ WARNING: Key exceeds 2,953 characters. It will be very hard to scan as a QR Code.");
  } else if (finalKeyLength > 1500) {
    console.log("💡 INFO: Will fit in a QR Code, but requires high resolution / clean print to scan reliably.");
  } else {
    console.log("✅ SUCCESS: Key size is optimal for a QR Code!");
  }
}

// --- TEST IT WITH YOUR DATA ---
// Replace this sample object with your actual 5KB data structure
const mySampleData = {
  testArray: Array.from({ length: 50 }, (_, i) => ({
    id: i,
    name: `User_${i}`,
    email: `user${i}@companyLocalDomain.com`,
    isActive: i % 2 === 0,
    roles: ["viewer", "editor"]
  }))
};

measureJsonKeyLength(mySampleData);
