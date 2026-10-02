// NHA's standard consent language for Aadhaar-based HPR creation, verbatim from NHA's HPR test
// cases (HPR_Test_Cases_Final, rows HPR-003/HPR-004/HPR-006, "Standard Consent Language for
// Aadhaar"). HPR-003 requires it to be shown as given; HPR-004 requires Hindi as well as English.
// Do not edit the wording: replace it only with a newer text from NHA, and bump the version.
//
// The Hindi second paragraph ends at "सुरक्षित रखता" in NHA's sheet, without the closing "हूं।";
// it is kept exactly as published.
export const HPR_AADHAAR_CONSENT_VERSION = 'nha-hpr-test-cases-final';

export const HPR_AADHAAR_CONSENT = {
    en: {
        label: 'English',
        paragraphs: [
            'I, hereby declare that I am voluntarily sharing my Aadhaar Number / Virtual ID and demographic information issued by UIDAI, with National Health Authority (NHA) for the sole purpose of creation of Healthcare Professional ID. I understand that my Healthcare Professional ID can be used and shared for purposes as may be notified by Ayushman Bharat Digital Mission (ABDM) from time to time including provision of healthcare services. Further, I am aware that my personal identifiable information (Name, Address, Age, Date of Birth, Gender and Photograph) may be made available to the entities working in the National Digital Health Ecosystem (NDHE) which inter alia includes stakeholders and entities such as healthcare professional (e.g. doctors), facilities (e.g. hospitals, laboratories) and data fiduciaries (e.g. health programmes), which are registered with or linked to the Ayushman Bharat Digital Mission (ABDM), and various processes there under. I authorize NHA to use my Aadhaar number / Virtual ID for performing Aadhaar based authentication with UIDAI as per the provisions of the Aadhaar (Targeted Delivery of Financial and other Subsidies, Benefits and Services) Act, 2016 for the aforesaid purpose. I understand that UIDAI will share my e-KYC details, or response of “Yes” with NHA upon successful authentication.',
            'I consciously choose to use Aadhaar number / Virtual ID for the purpose of availing benefits across the NDHE. I am aware that my personal identifiable information excluding Aadhaar number / VID number can be used and shared for purposes as mentioned above. I reserve the right to revoke the given consent at any point of time as per provisions of Aadhar Act and Regulations and other laws, rules and regulations.',
        ],
        agree: 'I agree to the above.',
    },
    hi: {
        label: 'हिंदी',
        paragraphs: [
            "इसके द्वारा मैं यह स्पष्ट करता हूं कि मैं स्वैच्छिक रूप से हेल्थकेयर प्रोफेशनल आईडी बनाने के एकमात्र उद्देश्य के लिए राष्ट्रीय स्वास्थ्य प्राधिकरण (एनएचए) के साथ यूआईडीएआई (UIDAI) द्वारा जारी अपना आधार नंबर/ वर्चुअल आईडी और जनसांख्यिकीय जानकारी साझा कर रहा हूं। मैं भली भांति जानता हूं कि मेरी हेल्थकेयर प्रोफेशनल आईडी को आयुष्मान भारत डिजिटल मिशन (एबीडीएम) द्वारा समय-समय पर स्वास्थ्य सेवाओं के प्रावधान सहित अधिसूचित उद्देश्यों के लिए उपयोग और साझा किया जा सकता है। और इसके अलावा, मैं इस बात से भी अवगत हूँ कि मेरी व्यक्तिगत पहचान स्थापित करने योग्य जानकारी (नाम, पता, आयु, जन्म तिथि, लिंग और फोटोग्राफ) राष्ट्रीय डिजिटल स्वास्थ्य इकोसिस्टम (एनडीएचई) में काम करने वाली संस्थाओं को उपलब्ध कराई जा सकती है, जिसमें अन्य बातों के साथ-साथ हितधारक और संस्थाएं शामिल हैं जैसे कि आयुष्मान भारत डिजिटल मिशन (एबीडीएम) के साथ पंजीकृत या उससे जुड़े हुए स्वास्थ्य पेशेवर (जैसे डॉक्टर), सुविधाएं (जैसे अस्पताल, प्रयोगशालाएं) और डेटा प्रत्ययी (data fiduciaries) (जैसे स्वास्थ्य कार्यक्रम) और उसके तहत आने वाली विभिन्न प्रक्रियाएं। मैं उपरोक्त उद्देश्य के लिए आधार (वित्तीय और अन्य सब्सिडी, लाभ और सेवाओं की लक्षित डिलीवरी) अधिनियम, 2016 के प्रावधानों के अनुसार यूआईडीएआई (UIDAI) के साथ आधार आधारित प्रमाणीकरण करने के लिए एनएचए को मेरे आधार नंबर/ वर्चुअल आईडी का उपयोग करने के लिए अधिकृत करता हूं। मैं जनता हूं कि यूआईडीएआई (UIDAI) मेरे ई-केवाईसी विवरण या सफल प्रमाणीकरण पर 'हां' की प्रतिक्रिया के बाद एनएचए के साथ साझा करेगा।",
            'मैं एनडीएचई में लाभ प्राप्त करने के उद्देश्य से ऐच्छिक रूप से आधार संख्या/ वर्चुअल आईडी का उपयोग करना चुनता हूं। मुझे ज्ञात है कि आधार संख्या/ वीआईडी संख्या को छोड़कर मेरी व्यक्तिगत पहचान स्थापित करने योग्य जानकारी का उपयोग ऊपर बताए गए उद्देश्यों के लिए किया और साझा किया जा सकता है। मैं आधार अधिनियम और विनियमों और अन्य कानूनों, नियमों और विनियमों के प्रावधानों के अनुसार दी गई सहमति को किसी भी समय रद्द करने का अधिकार सुरक्षित रखता',
        ],
        agree: 'मैं उपरोक्त से सहमत हूं।',
    },
};

/** Resend policy (HPR-008): up to 2 resends, each at least 60 s after the last send; then 30 min. */
export const OTP_RESEND = { waitMs: 60_000, maxResends: 2, blockMs: 30 * 60_000 };

/** Whether an OTP can be resent now: { ok, availableAt?, blockedUntil?, remaining }. */
export function resendState(sends, now) {
    if (!sends) return { ok: false, remaining: 0 };
    let { resends, lastAt } = sends;
    if (resends >= OTP_RESEND.maxResends) {
        const blockedUntil = lastAt + OTP_RESEND.blockMs;
        if (now < blockedUntil) return { ok: false, blockedUntil, remaining: 0 };
        resends = 0; // the block has passed: a fresh allowance
    }
    const availableAt = lastAt + OTP_RESEND.waitMs;
    return { ok: now >= availableAt, availableAt, remaining: OTP_RESEND.maxResends - resends };
}

/** The send counter after an OTP is (re)sent at `now`. */
export function afterSend(sends, now, isResend) {
    if (!isResend || !sends) return { resends: 0, lastAt: now };
    const blockedOver = sends.resends >= OTP_RESEND.maxResends && now >= sends.lastAt + OTP_RESEND.blockMs;
    return { resends: (blockedOver ? 0 : sends.resends) + 1, lastAt: now };
}
