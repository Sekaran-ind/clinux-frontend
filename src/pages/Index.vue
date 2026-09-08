<script setup>
// Ported from clinixflow's public/index.html — the marketing landing page + plain-object
// (non-FHIR) clinic-admin auth (Register/Login/Profile modals). The decorative auto-playing
// carousel is rewritten as reactive Vue state (currentSlide ref) instead of the original's
// direct DOM manipulation (track.style.transform, dots.forEach, etc.) — same visual behavior,
// idiomatic to the new framework rather than a literal port of imperative DOM code.
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useEntryWorkflowStore } from '../stores/entryWorkflow.js';
import { useThemeStore } from '../stores/theme.js';
import RegisterForm from '../components/auth/RegisterForm.vue';
import LoginForm from '../components/auth/LoginForm.vue';
import Cubo from '../components/Cubo.vue';
import { useCuboStore } from '../stores/cubo.js';

const router = useRouter();
const auth = useAuthStore();
const entryWorkflow = useEntryWorkflowStore();
const theme = useThemeStore();
const cubo = useCuboStore();

// SPEC-20: opens Cübo directly (its General thread hosts Register/Login/Forgot Password/Change
// Password) instead of routing to a separate page — see clinux-spec20-get-started-journey-
// workbench memory note for why this replaced an earlier standalone-page version.
//
// UPDATE (corrects the previous, wrong attempt at this): NOT an inline section on Index.vue —
// user's explicit correction: "open cubo as a separate page route with threads as the left pane,
// chat in the middle pane and right pane shows pages as necessary... 3 pane mode is also another
// [layout] option for the user to switch". The /ai-engine route now hosts Cübo's own THREE_PANE
// layout directly (CuboWorkspace.vue) — this just navigates there and sets the layout; Cübo owns
// all three panes itself on that page, same way FAB/EXPANDED/MODAL_DOCK are layout modes it owns.
function openGuidedSetup() {
  cubo.currentLayout = 'THREE_PANE';
  router.push('/ai-engine');
}

// Closes the user-menu dropdown on any click outside it — replaces Alpine's @click.away, which
// has no built-in Vue equivalent (no v-click-outside directive ships with core Vue).
function closeUserMenuOnOutsideClick(e) {
  if (!e.target.closest('.user-menu-anchor')) userMenuOpen.value = false;
}
onMounted(() => document.addEventListener('click', closeUserMenuOnOutsideClick));
onUnmounted(() => document.removeEventListener('click', closeUserMenuOnOutsideClick));

const showRegister = ref(false);
const showLogin = ref(false);
const showProfile = ref(false);
const userMenuOpen = ref(false);
const toast = ref({ show: false, message: '' });

const profileForm = reactive({ clinicName: '', adminName: '', designation: '', careTeam: '', services: '', phone: '', city: '', address: '' });
const contactForm = reactive({ name: '', clinic: '', email: '', message: '' });

const features = [
  { icon: 'fas fa-microphone-alt', title: 'Ambient Voice Capture', desc: 'Passively records multi-provider consultation audio without interrupting clinical workflow. Cübo parses every clinical keyword automatically.' },
  { icon: 'fas fa-file-medical-alt', title: 'Instant SOAP Generation', desc: 'Translates raw conversation into structured Subjective, Objective, Assessment, and Plan notes in seconds — fully compliant, zero manual data entry required.' },
  { icon: 'fas fa-eye', title: 'Diagnostic Vision AI', desc: 'Processes imaging from PACS/DICOM systems, extracting spatial measurements and flagging anomalies for the Objective section of SOAP notes.' },
  { icon: 'fas fa-users', title: 'Multi-Specialty Collaboration', desc: 'Connects physicians, radiologists, physios, and labs on a shared, active timeline—eliminating documentation silos for truly collaborative diagnosis.' },
  { icon: 'fas fa-shield-alt', title: 'Safety & Privacy First', desc: 'Sensitive data never leaves your clinic network. Enterprise-grade security ensures 100% patient data isolation within a sovereign cloud environment.' },
  { icon: 'fas fa-exchange-alt', title: 'EHR Interoperability', desc: 'Auto-generates FHIR compliant compositions compatible with major EHR platforms for seamless referral transfers.' },
];

const steps = [
  { icon: 'fas fa-microphone', label: 'Physician Input', desc: 'ClinüxFlow listens to the consultation room dictation/conversation, also allows manual edits and upload images.' },
  { icon: 'fas fa-brain', label: 'Analyse', desc: 'AI engine extracts clinical intent, symptoms, findings, and plans. Raises critical findings based on established practices.' },
  { icon: 'fas fa-person-chalkboard', label: 'Structure', desc: 'Generate S-O-A-P note and map clinical terms to standardized codes using Snowmed-CT, IONIC & ICD-10 for internal use.' },
  { icon: 'fas fa-file-prescription', label: 'Physician Approval', desc: 'Clinician reviews, edits, and approves the prescrption. Dictates Care Plan (Medication dosages, Orders & Notes).' },
  { icon: 'fas fa-coins', label: 'Billing & Integration', desc: 'Facilate QR Code based payment to Providers directly and provides FHIR resource composition for native EHR intergration.' },
];

const plans = [
  { name: 'Free Plan', tagline: 'For small clinics getting started', price: '₹0.00', featured: false, features: ['Up to 3 care team members', '100 SOAP notes/month', 'Voice-to-text transcription', 'Email support', 'Basic analytics'] },
  { name: 'Professional', tagline: 'Most chosen by multi-specialty clinics', price: '₹4,999', featured: true, features: ['Up to 15 care team members', 'Unlimited SOAP notes', 'Vision AI for imaging', 'Priority support', 'EHR export (FHIR-R4)'] },
  { name: 'Enterprise', tagline: 'For hospital networks & chains', price: 'Custom', featured: false, features: ['Unlimited care team members', 'Unlimited SOAP notes', 'Full imaging AI suite', 'Dedicated account manager', 'On-premise deployment option', 'SLA-backed uptime guarantee'] },
];

const partners = ['Small and Medium Sized Clinics', 'Multi-Specialty Clinics', 'Laboratories', 'Radiology & Imaging Centers', 'Pharmacies', 'Blood Banks', 'Diagnostic Centers', 'Hospitals & Hospital Networks'];

function showToast(msg) {
  toast.value = { show: true, message: msg };
  setTimeout(() => (toast.value.show = false), 3000);
}

const ROLE_LABELS = {
  hospital_admin: 'Hospital Admin',
  health_professional: 'Health Professional',
  admin_and_health_professional: 'Admin & Health Professional',
};

// SPEC-20: RegisterForm/LoginForm now own their own field state, validation, and dispatch (via
// entryWorkflow.js's real ENTRY_PLAN_DEFINITION runtime) — this page just reacts to their
// `success` events with what used to be registerClinic()/loginClinic()'s own tail end (close the
// modal, toast, navigate). Same components render inline in Cübo's General thread (see
// Cubo.vue) — no duplicated form markup between the two hosts any more.
function onRegisterSuccess({ role }) {
  showRegister.value = false;
  // Deliberately NOT "Welcome, {clinicName}" -- clinicName is just a placeholder until the new
  // Hospital/HFR journey replaces it with the real hospital_name (see SPEC-11).
  showToast(`Welcome${role ? ', ' + ROLE_LABELS[role] : ''}! Let's get you set up.`);
  router.push('/clinic-home');
}

function onLoginSuccess() {
  showLogin.value = false;
  showToast(`Welcome back, ${auth.currentUser.clinicName}!`);
}

function logout() {
  entryWorkflow.logout();
  showToast('Signed out successfully.');
}

function openProfile() {
  if (!auth.currentUser) return;
  Object.assign(profileForm, auth.currentUser);
  showProfile.value = true;
}

function saveProfile() {
  auth.saveProfile({ ...profileForm });
  showProfile.value = false;
  showToast('Profile updated successfully.');
}

function goToEngine() {
  if (!auth.currentUser) { showLogin.value = true; return; }
  router.push('/ai-engine');
}

// Routes to the clinic's published public page if setup is already done, otherwise back into
// onboarding to finish it.
function goToClinic() {
  if (!auth.currentUser) { showLogin.value = true; return; }
  const hasProfile = !!localStorage.getItem('cf_clinic_profile');
  router.push(hasProfile ? '/clinic-home' : '/onboarding');
}

async function sendContact(e) {
  const payloadData = { type: 'email', name: contactForm.name, clinic: contactForm.clinic, email: contactForm.email, message: contactForm.message };
  try {
    const response = await fetch('https://helpdesk.tsekaran1949.workers.dev', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payloadData),
    });
    const result = await response.json();
    if (result.success) {
      showToast('Message sent! Our team will respond within 24 hours.');
      Object.assign(contactForm, { name: '', clinic: '', email: '', message: '' });
    } else {
      showToast('Error sending message! Our team will respond within 24 hours.');
    }
  } catch (err) {
    showToast('Error sending message! Our team will respond within 24 hours.');
  }
}

// Decorative carousel — reactive Vue equivalent of the original's imperative DOM manipulation.
const currentSlide = ref(0);
const totalSlides = 3;
const statusStates = [
  { text: '🎙️ Digitizing triage inputs & measuring patient vitals...', colorClass: 'text-amber-500', bgClass: 'bg-amber-500' },
  { text: '⚡ Transcribe ambient clinical audio into structured SOAP notes...', colorClass: 'text-teal-500', bgClass: 'bg-teal-500' },
  { text: '✅ Medical coding, paperless invoicing & payment processing...', colorClass: 'text-emerald-500', bgClass: 'bg-emerald-500' },
];
let slideInterval = null;
function goToSlide(i) { currentSlide.value = i; }
function nextSlide() { currentSlide.value = (currentSlide.value + 1) % totalSlides; }
function startAutoplay() { clearInterval(slideInterval); slideInterval = setInterval(nextSlide, 4000); }
function stopAutoplay() { clearInterval(slideInterval); }
onMounted(startAutoplay);
onUnmounted(stopAutoplay);
</script>

<template>
  <!-- Register Modal -->
  <div class="modal-backdrop" v-show="showRegister" @click.self="showRegister = false">
    <div class="modal-box" @click.stop>
      <div class="flex items-center justify-between mb-6">
        <div>
          <h2 class="text-xl font-bold cf-text-strong" style="font-family:'Poppins',sans-serif">Create Your Account</h2>
          <p class="text-sm cf-text mt-1">You'll set up your facility and/or professional details next</p>
        </div>
        <button @click="showRegister = false" class="w-9 h-9 rounded-full cf-card flex items-center justify-center hover:text-red-500"><i class="fas fa-times text-sm"></i></button>
      </div>
      <!-- SPEC-20: same RegisterForm component Cübo's General thread renders inline — no
           duplicated form markup between the modal here and the Cübo-hosted case. -->
      <RegisterForm @success="onRegisterSuccess" @switch-to-login="showRegister = false; showLogin = true" />
    </div>
  </div>

  <!-- Login Modal -->
  <div class="modal-backdrop" v-show="showLogin" @click.self="showLogin = false">
    <div class="modal-box" @click.stop>
      <div class="flex items-center justify-between mb-6">
        <div>
          <h2 class="text-xl font-bold cf-text-strong" style="font-family:'Poppins',sans-serif">Welcome Back</h2>
          <p class="text-sm cf-text mt-1">Sign in to your clinic workspace</p>
        </div>
        <button @click="showLogin = false" class="w-9 h-9 rounded-full cf-card flex items-center justify-center hover:text-red-500"><i class="fas fa-times text-sm"></i></button>
      </div>
      <LoginForm @success="onLoginSuccess" @switch-to-register="showLogin = false; showRegister = true" />
    </div>
  </div>

  <!-- Profile Modal -->
  <div class="modal-backdrop" v-show="showProfile" @click.self="showProfile = false">
    <div class="modal-box" @click.stop style="max-width:600px">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h2 class="text-xl font-bold cf-text-strong" style="font-family:'Poppins',sans-serif">Clinic Profile</h2>
          <p class="text-sm cf-text mt-1">Manage your clinic's information</p>
        </div>
        <button @click="showProfile = false" class="w-9 h-9 rounded-full cf-card flex items-center justify-center hover:text-red-500"><i class="fas fa-times text-sm"></i></button>
      </div>
      <form @submit.prevent="saveProfile()" class="space-y-4" v-show="auth.currentUser">
        <div><label class="cf-label">Clinic Name</label><input class="cf-input" v-model="profileForm.clinicName" /></div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="cf-label">Admin Name</label><input class="cf-input" v-model="profileForm.adminName" /></div>
          <div><label class="cf-label">Designation</label><input class="cf-input" v-model="profileForm.designation" /></div>
        </div>
        <div><label class="cf-label">Care Team Members</label><textarea class="cf-input" rows="2" v-model="profileForm.careTeam" placeholder="Dr. Sharma (Cardiologist), Dr. Priya (Radiologist)..."></textarea></div>
        <div><label class="cf-label">Services Offered</label><textarea class="cf-input" rows="2" v-model="profileForm.services" placeholder="Cardiology, Radiology, Orthopaedics..."></textarea></div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="cf-label">Phone</label><input class="cf-input" v-model="profileForm.phone" /></div>
          <div><label class="cf-label">City</label><input class="cf-input" v-model="profileForm.city" /></div>
        </div>
        <div><label class="cf-label">Address</label><textarea class="cf-input" rows="2" v-model="profileForm.address" placeholder="123 Medical Complex, HSR Layout..."></textarea></div>
        <button type="submit" class="btn-primary w-full"><i class="fas fa-save mr-2"></i>Save Changes</button>
      </form>
    </div>
  </div>

  <!-- Toast -->
  <div class="cf-toast" v-show="toast.show"><i class="fas fa-check-circle mr-2" style="color:var(--color-primary)"></i><span>{{ toast.message }}</span></div>

  <!-- This page's own marketing nav — distinct from App.vue's shared "app shell" nav (which is
       suppressed for this route via router meta.hideAppNav), since the original index.html's nav
       (Features/Pricing/Partners/Contact anchors + auth state) has nothing in common with the
       simple "logo + badge + dark toggle + back link" nav every clinical workflow page uses. -->
  <nav class="cf-nav fixed top-0 w-full z-40">
    <div class="max-w-7xl mx-auto px-6 flex items-center justify-between h-16">
      <a href="#hero" class="flex items-center gap-2">
        <div class="bg-(--color-primary) text-(--color-secondary) font-black text-2xl px-2.5 py-1 rounded shadow-lg font-mono">CÜ</div>
        <span class="font-bold text-xl cf-text-strong" style="font-family:'Poppins',sans-serif">Clinüx<span style="color:var(--color-primary)">Flow </span>
          <p class="text-xs font-bold cf-text-strong" style="font-family:'Poppins',sans-serif"><em>Trusted Partner of ABDM </em>
            <img style="display:inline;vertical-align:middle" src="/india.svg" width="20" height="20" alt="Flag of India" />
          </p>
        </span>
      </a>
      <div class="hidden md:flex items-center gap-7 text-sm">
        <a href="#features" class="nav-link">Features</a>
        <a href="#pricing" class="nav-link">Pricing</a>
        <a href="#partners" class="nav-link">Partners</a>
        <a href="#contact" class="nav-link">Contact</a>
      </div>
      <div class="flex items-center gap-3">
        <button @click="theme.toggle()" class="w-9 h-9 rounded-full cf-card flex items-center justify-center hover:border-teal-400 text-sm">
          <i :class="theme.isDark ? 'fas fa-sun' : 'fas fa-moon'" class="cf-text"></i>
        </button>
        <div v-if="!auth.currentUser" class="flex items-center gap-2">
          <button @click="showLogin = true" class="btn-outline text-sm py-2 px-4">Sign In</button>
          <button @click="showRegister = true" class="btn-primary text-sm py-2 px-4">Register</button>
        </div>
        <div v-else class="relative user-menu-anchor">
          <button @click="userMenuOpen = !userMenuOpen" class="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm" style="background:var(--color-primary);color:var(--color-secondary)" :title="auth.currentUser.clinicName">
            <span>{{ auth.currentUser.clinicName.charAt(0).toUpperCase() }}</span>
          </button>
          <div v-show="userMenuOpen" class="absolute right-0 mt-2 w-48 cf-card rounded-xl shadow-xl overflow-hidden py-1">
            <div class="px-4 py-2 border-b" style="border-color:var(--cf-border)">
              <p class="text-xs font-bold cf-text-strong truncate">{{ auth.currentUser.clinicName }}</p>
              <p class="text-xs cf-text truncate">{{ auth.currentUser.email }}</p>
            </div>
            <button @click="openProfile(); userMenuOpen = false" class="w-full text-left px-4 py-2 text-sm cf-text hover:bg-teal-50 dark:hover:bg-teal-900/20">
              <i class="fas fa-id-card mr-2 text-xs" style="color:var(--color-primary)"></i>Edit Profile
            </button>
            <button @click="logout(); userMenuOpen = false" class="w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">
              <i class="fas fa-sign-out-alt mr-2 text-xs"></i>Sign Out
            </button>
          </div>
        </div>
      </div>
    </div>
  </nav>

  <section id="hero" class="relative overflow-hidden" style="background:var(--cf-bg);padding:6rem 0">
    <div style="position:absolute;inset:0;overflow:hidden;pointer-events:none">
      <div style="position:absolute;width:800px;height:800px;border-radius:50%;border:1px solid rgba(0,212,178,0.08);top:50%;left:50%;transform:translate(-50%,-50%)"></div>
      <div style="position:absolute;width:550px;height:550px;border-radius:50%;border:1px solid rgba(0,212,178,0.14);top:50%;left:50%;transform:translate(-50%,-50%)"></div>
      <div style="position:absolute;width:320px;height:320px;border-radius:50%;border:1px solid rgba(0,212,178,0.22);top:50%;left:50%;transform:translate(-50%,-50%)"></div>
      <div style="position:absolute;width:500px;height:500px;border-radius:50%;background:radial-gradient(circle,rgba(0,212,178,0.07) 0%,transparent 70%);top:20%;right:-5%;pointer-events:none"></div>
    </div>

    <div class="max-w-7xl mx-auto px-6 py-20 relative z-10">
      <div class="max-w-3xl">
        <h1 class="text-6xl md:text-7xl font-extrabold leading-tight cf-text-strong mb-4" style="letter-spacing:-2px">Clinüx<span class="grad-text">Flow </span> <img style="display:inline;vertical-align:middle" src="/india.svg" width="50" height="50" alt="Flag of India" /></h1>
        <p class="text-2xl font-semibold mb-3" style="color:var(--color-primary);font-family:'Poppins',sans-serif"><em><i class="fa-solid fa-arrows-turn-to-dots"></i> Moving Care in every step and Corner.</em></p>
        <p class="text-lg cf-text mb-10 max-w-2xl leading-relaxed">
          Clinüxflow increases upto 30% of the valuable consultation face time with patients and unburdens administrative and cognitive overloads by digitally connecting patients, providers, and payers through <b>frictionless care continuity across their entire end-to-end journey.</b>
        </p>
        <p class="text-sm cf-text mb-5 max-w-2xl"><b>- Using Cübo train your personal digital twin and tailor your care preferences.</b></p>
        <p class="text-sm cf-text mb-10 max-w-2xl"><b>- Addressing needs of solo rural practices, medium and metropolitan hospital networks alike.</b></p>

        <div class="flex flex-wrap gap-4">
          <button v-if="!auth.currentUser" @click="showRegister = true" class="btn-teal inline-flex items-center gap-2"><i class="fas fa-hospital-user"></i>Register Your Clinic</button>
          <button v-if="auth.currentUser" @click="goToEngine()" class="btn-teal inline-flex items-center gap-2"><p  class="bg-(--color-secondary) text-(--color-primary) font-black text-2xl px-2.5 py-1 rounded shadow-lg font-mono" >CÜ </p>- Talk to Cübo</button>
          <a v-if="!auth.currentUser" href="#workflow" class="btn-outline inline-flex items-center gap-2"><i class="text-md font-bold fas fa-play-circle"></i>See How It Works</a>
          <!-- SPEC-20 (docs/SPEC-20-REFERENCE-PATTERN-JOURNEY-WORKBENCH-AND-UNAUTH-CUBO-ENTRY.md) —
               additive entry point, same precedent HospitalOnboarding.vue's "Try the chat-based
               setup" card set for SPEC-14: the existing Register/Sign-in modals above are
               untouched, this just offers the new Cübo-hosted flow alongside them. -->
          <button v-if="!auth.currentUser" @click="openGuidedSetup()" class="btn-outline inline-flex items-center gap-2"><i class="text-md font-bold fas fa-comments"></i>Try Guided Setup with Cübo</button>
          <button v-if="auth.currentUser" @click="goToClinic()" class="btn-teal inline-flex items-center gap-2"><span class="text-md font-bold truncate">{{ auth.currentUser.clinicName }}</span></button>
        </div>

        <div class="hidden lg:flex absolute right-0 top-1/2 -translate-y-1/2 items-center justify-center" style="width:40%">
          <div class="relative w-full max-w-md">
            <div class="rounded-2xl p-6 shadow-2xl" style="background:var(--cf-bg-alt);border:1px solid var(--cf-border)">
              <div class="flex items-center gap-3 mb-4">
                <span class="flex h-2 w-2 relative">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" :class="statusStates[currentSlide].bgClass"></span>
                  <span class="relative inline-flex rounded-full h-2 w-2" :class="statusStates[currentSlide].colorClass"></span>
                </span>
                <div>
                  <p class="text-xs font-bold cf-text-strong" style="font-family:'Poppins',sans-serif">Patient Journey</p>
                  <p class="text-xs cf-text">Patient: Arjun Verma · Just now</p>
                </div>
                <span class="ml-auto text-xs font-bold px-2 py-0.5 rounded-full" style="background:rgba(0,212,178,.15);color:var(--color-primary)">Live</span>
                <div class="flex gap-1">
                  <span class="w-1.5 h-1.5 rounded-full" style="background:var(--color-primary);animation:bounce 1s infinite 0s"></span>
                  <span class="w-1.5 h-1.5 rounded-full" style="background:var(--color-primary);animation:bounce 1s infinite .2s"></span>
                  <span class="w-1.5 h-1.5 rounded-full" style="background:var(--color-primary);animation:bounce 1s infinite .4s"></span>
                </div>
              </div>

              <div class="w-full max-w-md mx-auto space-y-4 select-none relative">
                <div class="w-full overflow-hidden relative rounded-xl" style="border:1px solid var(--cf-border)" @mouseenter="stopAutoplay()" @mouseleave="startAutoplay()">
                  <div class="flex transition-transform duration-700 ease-in-out w-[300%]" :style="`transform:translateX(-${(currentSlide * 100) / totalSlides}%)`">
                    <!-- PANE 1: FRONT DESK WORKFLOW -->
                    <div class="w-1/3 p-3 flex-shrink-0" style="background:var(--cf-bg)">
                      <div class="flex items-center space-x-2 font-bold text-sm mb-3" style="color:var(--color-primary)"><span>📋</span><span>Step 1: Front Desk Workflow</span></div>
                      <div class="grid grid-cols-2 gap-3">
                        <div class="rounded-lg p-3" style="background:var(--cf-bg);border:1px solid var(--cf-border)"><p class="text-xs font-bold mb-1" style="color:var(--color-primary)">Token & Onboarding</p><p class="text-xs cf-text font-mono font-bold text-base" style="color:var(--color-primary)">#CX-0402</p><p class="text-[10px] opacity-75 mt-0.5">Time: 10:14 AM IST</p></div>
                        <div class="rounded-lg p-3" style="background:var(--cf-bg);border:1px solid var(--cf-border)"><p class="text-xs font-bold mb-1" style="color:var(--color-primary)">Preliminary Complaint</p><p class="text-xs cf-text">Acute chest tightness starting post-breakfast. Shortness of breath.</p></div>
                        <div class="rounded-lg p-3" style="background:var(--cf-bg);border:1px solid var(--cf-border)"><p class="text-xs font-bold mb-1" style="color:var(--color-primary)">Vitals Measurements</p><p class="text-xs cf-text">Temp: 98.4°F | SpO₂: 97%<br>BP: 138/88 mmHg | HR: 94 bpm</p></div>
                        <div class="rounded-lg p-3" style="background:var(--cf-bg);border:1px solid var(--cf-border)"><p class="text-xs font-bold mb-1" style="color:var(--color-primary)">Triage & Consultant</p><p class="text-xs cf-text"><span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500 bg-opacity-20 text-amber-500 mb-1">PRIORITY 2 — URGENT</span><br>Dr. Lakshmi (Cardiology)</p></div>
                      </div>
                    </div>
                    <!-- PANE 2: CONSULTATION ROOM (SOAP) -->
                    <div class="w-1/3 p-3 flex-shrink-0" style="background:var(--cf-bg);border-left:1px solid var(--cf-border);border-right:1px solid var(--cf-border)">
                      <div class="flex items-center space-x-2 font-bold text-sm mb-3" style="color:var(--color-primary)"><span>🩺</span><span>Step 2: Consultation Room (SOAP)</span></div>
                      <div class="grid grid-cols-2 gap-3">
                        <div class="rounded-lg p-3" style="background:var(--cf-bg);border:1px solid var(--cf-border)"><p class="text-xs font-bold mb-1" style="color:var(--color-primary)">S — Subjective</p><p class="text-xs cf-text">Chest tightness since morning. SOB on exertion. No fever.</p></div>
                        <div class="rounded-lg p-3" style="background:var(--cf-bg);border:1px solid var(--cf-border)"><p class="text-xs font-bold mb-1" style="color:var(--color-primary)">O — Objective</p><p class="text-xs cf-text">BP 138/88 mmHg. HR 94 bpm. SpO₂ 97%. ECG normal sinus.</p></div>
                        <div class="rounded-lg p-3" style="background:var(--cf-bg);border:1px solid var(--cf-border)"><p class="text-xs font-bold mb-1" style="color:var(--color-primary)">A — Assessment</p><p class="text-xs cf-text">Likely musculoskeletal chest pain. Rule out cardiac origin.</p></div>
                        <div class="rounded-lg p-3" style="background:var(--cf-bg);border:1px solid var(--cf-border)"><p class="text-xs font-bold mb-1" style="color:var(--color-primary)">P — Plan</p><p class="text-xs cf-text">Echo stress test. Tab. Pantop 40mg OD. Follow-up in 7 days.</p></div>
                      </div>
                    </div>
                    <!-- PANE 3: BILLING & INVOICING -->
                    <div class="w-1/3 p-3 flex-shrink-0 relative overflow-hidden" style="background:var(--cf-bg)">
                      <div class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-[0.08] dark:opacity-[0.12] z-10 select-none">
                        <p class="text-7xl font-black tracking-widest uppercase border-8 border-emerald-500 rounded-2xl px-6 py-2 transform -rotate-12 text-emerald-500">PAID</p>
                      </div>
                      <div class="flex items-center space-x-2 font-bold text-sm mb-3" style="color:var(--color-primary)"><span>💳</span><span>Step 3: Billing & Payments</span></div>
                      <div class="grid grid-cols-2 gap-3 relative z-0">
                        <div class="rounded-lg p-3" style="background:var(--cf-bg);border:1px solid var(--cf-border)"><p class="text-xs font-bold mb-1" style="color:var(--color-primary)">Consultation Fee</p><p class="text-xs cf-text">General Cardiology Assessment</p><p class="text-sm font-semibold mt-1" style="color:var(--color-primary)">₹500.00</p></div>
                        <div class="rounded-lg p-3" style="background:var(--cf-bg);border:1px solid var(--cf-border)"><p class="text-xs font-bold mb-1" style="color:var(--color-primary)">Lab & Procedure Fees</p><p class="text-xs cf-text">12-Lead Baseline ECG Test</p><p class="text-sm font-semibold mt-1" style="color:var(--color-primary)">₹350.00</p></div>
                        <div class="rounded-lg p-3 col-span-2 flex justify-between items-center" style="background:var(--cf-bg);border:1px solid var(--cf-border)">
                          <div><p class="text-xs font-bold" style="color:var(--color-primary)">Total Invoice Amount</p><p class="text-[10px] opacity-75">Settled via UPI Paperless Payment</p></div>
                          <div class="text-right"><p class="text-base font-black tracking-wide text-emerald-500">₹850.00</p><span class="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500 bg-opacity-20 text-emerald-500">TRANSACTION SUCCESS</span></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="w-full flex items-center justify-between p-2.5 rounded-lg border text-xs transition-all duration-300" style="background:var(--cf-bg);border-color:var(--cf-border)">
                  <span class="text-[10px] uppercase font-bold tracking-wider opacity-60 flex items-center space-x-1">
                    <div class="w-8 h-8 rounded-lg flex items-center justify-center" style="background:var(--color-primary)"><p class="font-black text-xl px-2.5 py-1" style="color:var(--color-secondary)">ü</p></div>
                    <span>Cübo powered</span>
                  </span>
                  <div class="flex items-center space-x-2"><span class="cf-text font-medium tracking-wide">{{ statusStates[currentSlide].text }}</span></div>
                </div>

                <div class="flex justify-center items-center space-x-3 mt-2">
                  <button v-for="i in [0, 1, 2]" :key="i" @click="goToSlide(i)" class="clinux-dot w-2.5 h-2.5 rounded-full transition-all duration-300" :class="currentSlide === i ? '' : 'opacity-30'" :style="`background-color:var(--color-primary);transform:scale(${currentSlide === i ? 1.25 : 1})`" :aria-label="`Go to Step ${i + 1}`"></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section id="workflow" style="background:var(--cf-bg-alt);padding:6rem 0">
    <div class="max-w-7xl mx-auto px-6">
      <div class="text-center mb-14">
        <p class="section-eyebrow mb-3">The Workflow - Synchronized Patient Care</p>
        <div class="teal-line mx-auto mb-5"></div>
        <h2 class="text-4xl font-bold cf-text-strong" style="letter-spacing:-1px">Quality Patient Conversations, <em style="color:var(--color-primary)">ONE</em>&nbsp;Shared Health Record and Reduced EHR Screen Time</h2>
      </div>
      <div class="flex flex-col md:flex-row items-start gap-4">
        <div v-for="(step, idx) in steps" :key="step.label" class="flex-1 flex flex-col items-center text-center p-6 rounded-2xl relative feature-card">
          <div class="w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg mb-4" style="background:var(--color-secondary);color:var(--color-primary);font-family:'Poppins',sans-serif">{{ idx + 1 }}</div>
          <i :class="step.icon" class="text-2xl mb-4" style="color:var(--color-primary)"></i>
          <h4 class="font-bold cf-text-strong mb-2" style="font-family:'Poppins',sans-serif">{{ step.label }}</h4>
          <p class="text-sm cf-text">{{ step.desc }}</p>
        </div>
      </div>
    </div>
  </section>

  <section id="features" style="background:var(--cf-bg);padding:6rem 0">
    <div class="max-w-7xl mx-auto px-6">
      <div class="text-center mb-14">
        <p class="section-eyebrow mb-3">What ClinüxFlow Does</p>
        <div class="teal-line mx-auto mb-5"></div>
        <h2 class="text-4xl font-bold cf-text-strong" style="letter-spacing:-1px">Built to empower clinical teams to focus on quality face-to-face patient interactions and uncover hidden diagnostic blind spots.</h2>
        <p class="cf-text mt-3 max-w-7xl mx-auto">ClinüxFlow an interoperable collaborative platform empowering doctors, nurses, and technicians to streamline patient intake to ai-assisted ambient transcription coding, all the way to discharge—whether you are a solo practitioner in a rural clinic or a multi-specialty care team in a metropolitan hospital.ClinüxFlow inherently learns your unique clinical preferences with every use, enabling semi-autonomous workflows tailored to your practice.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div v-for="f in features" :key="f.title" class="feature-card p-7">
          <div class="w-12 h-12 rounded-xl flex items-center justify-center mb-5 text-xl" style="background:rgba(0,212,178,.12)"><i :class="f.icon" style="color:var(--color-primary)"></i></div>
          <h3 class="font-bold text-lg cf-text-strong mb-2" style="font-family:'Poppins',sans-serif">{{ f.title }}</h3>
          <p class="text-sm cf-text leading-relaxed">{{ f.desc }}</p>
        </div>
      </div>
    </div>
  </section>

  <section id="pricing" style="background:var(--cf-bg-alt);padding:6rem 0">
    <div class="max-w-7xl mx-auto px-6">
      <div class="text-center mb-14">
        <p class="section-eyebrow mb-3">Simple, Transparent Pricing</p>
        <div class="teal-line mx-auto mb-5"></div>
        <h2 class="text-4xl font-bold cf-text-strong" style="letter-spacing:-1px">Choose the right plan for your clinic</h2>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
        <div v-for="plan in plans" :key="plan.name" class="pricing-card p-8 flex flex-col" :class="plan.featured ? 'featured' : ''">
          <span v-if="plan.featured" class="text-xs font-bold mb-4 inline-block px-3 py-1 rounded-full" style="background:var(--color-primary);color:var(--color-secondary);font-family:'Poppins',sans-serif;width:fit-content">Most Popular</span>
          <h3 class="font-bold text-xl mb-1" :class="plan.featured ? 'text-white' : 'cf-text-strong'" style="font-family:'Poppins',sans-serif">{{ plan.name }}</h3>
          <p class="text-sm mb-5" :class="plan.featured ? 'text-blue-200' : 'cf-text'">{{ plan.tagline }}</p>
          <div class="mb-6">
            <span class="text-4xl font-extrabold" :class="plan.featured ? 'text-white' : 'cf-text-strong'" style="font-family:'Poppins',sans-serif">{{ plan.price }}</span>
            <span class="text-sm ml-1" :class="plan.featured ? 'text-blue-200' : 'cf-text'">/month</span>
          </div>
          <ul class="space-y-3 flex-1 mb-8">
            <li v-for="f in plan.features" :key="f" class="flex items-start gap-3 text-sm" :class="plan.featured ? 'text-blue-100' : 'cf-text'">
              <i class="fas fa-check-circle mt-0.5 flex-shrink-0" style="color:var(--color-primary)"></i><span>{{ f }}</span>
            </li>
          </ul>
          <button @click="showRegister = true" class="w-full py-2.5 rounded-xl font-bold text-sm transition-all" :style="(plan.featured ? 'background:var(--color-primary);color:var(--color-secondary);' : 'background:var(--color-secondary);color:#fff;') + `font-family:'Poppins',sans-serif`">Get Started</button>
        </div>
      </div>
    </div>
  </section>

  <section id="partners" style="background:var(--cf-bg);padding:6rem 0">
    <div class="max-w-7xl mx-auto px-6">
      <div class="text-center mb-14">
        <p class="section-eyebrow mb-3">Trusted By</p>
        <div class="teal-line mx-auto mb-5"></div>
        <h2 class="text-4xl font-bold cf-text-strong" style="letter-spacing:-1px">Partners &amp; Integrations</h2>
        <p class="cf-text mt-3 max-w-xl mx-auto">ClinüxFlow integrates with the tools your teams already rely on — from imaging archives to EHR platforms.</p>
      </div>
      <div class="flex flex-wrap justify-center gap-4">
        <div v-for="p in partners" :key="p" class="partner-logo flex items-center gap-2.5"><i class="fas fa-hospital text-xs" style="color:var(--color-primary)"></i><span>{{ p }}</span></div>
      </div>
      <div class="mt-16 rounded-2xl p-8 md:p-12 text-center" style="background:var(--color-secondary)">
        <h3 class="text-2xl font-bold text-white mb-3" style="font-family:'Poppins',sans-serif">Next-Gen Clinical Resilience for the teams that never stop caring.</h3>
        <p class="text-blue-200 mb-6 max-w-lg mx-auto">Join our Partner network - Clinics are already saving time generating Prescriptions with AI.</p>
        <button @click="showRegister = true" class="btn-teal"><i class="fas fa-rocket mr-2"></i>Start Free Trial</button>
      </div>
    </div>
  </section>

  <section id="contact" style="background:var(--cf-bg-alt);padding:6rem 0">
    <div class="max-w-7xl mx-auto px-6">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-16">
        <div>
          <p class="section-eyebrow mb-3">Get In Touch</p>
          <div class="teal-line mb-5"></div>
          <h2 class="text-4xl font-bold cf-text-strong mb-4" style="letter-spacing:-1px">Let's talk about your clinic's needs</h2>
          <p class="cf-text leading-relaxed mb-8">Our clinical integration team is available to walk you through setup, answer technical questions, or plan a phased rollout for your facility.</p>
          <div class="space-y-4">
            <div class="flex items-center gap-4"><div class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style="background:rgba(0,212,178,.12)"><i class="fas fa-envelope text-sm" style="color:var(--color-primary)"></i></div><div><p class="text-xs cf-text font-medium">Email</p><p class="cf-text-strong font-semibold text-sm">helpdesk@yaxb.ai</p></div></div>
            <div class="flex items-center gap-4"><div class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style="background:rgba(0,212,178,.12)"><i class="fas fa-globe text-sm" style="color:var(--color-primary)"></i></div><div><p class="text-xs cf-text font-medium">Website</p><p class="cf-text-strong font-semibold text-sm">www.yaxb.ai</p></div></div>
            <div class="flex items-center gap-4"><div class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style="background:rgba(0,212,178,.12)"><i class="fas fa-map-marker-alt text-sm" style="color:var(--color-primary)"></i></div><div><p class="text-xs cf-text font-medium">Headquarters</p><p class="cf-text-strong font-semibold text-sm">Bengaluru, Karnataka, India</p></div></div>
          </div>
        </div>
        <div class="cf-card rounded-2xl p-8">
          <h3 class="text-xl font-bold cf-text-strong mb-6" style="font-family:'Poppins',sans-serif">Send us a message</h3>
          <form @submit.prevent="sendContact($event)" class="space-y-4">
            <div class="grid grid-cols-2 gap-3">
              <div><label class="cf-label">Your Name</label><input class="cf-input" v-model="contactForm.name" placeholder="Dr. Anita Sharma" required /></div>
              <div><label class="cf-label">Clinic Name</label><input class="cf-input" v-model="contactForm.clinic" placeholder="Apollo Diagnostics" /></div>
            </div>
            <div><label class="cf-label">Email</label><input class="cf-input" type="email" v-model="contactForm.email" placeholder="anita@clinic.com" required /></div>
            <div><label class="cf-label">Message</label><textarea class="cf-input" rows="4" v-model="contactForm.message" placeholder="Tell us about your clinic's size, specialty, and what you're hoping to achieve with ClinüxFlow..." required></textarea></div>
            <button type="submit" class="btn-primary w-full"><i class="fas fa-paper-plane mr-2"></i>Send Message</button>
          </form>
        </div>
      </div>
    </div>
  </section>

  <footer style="padding:3rem 0">
    <div class="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
      <div class="flex items-center gap-2">
        <div class="bg-(--color-primary) text-(--color-secondary) w-7 h-7 rounded-xs flex items-center justify-center"><i class="text-xs" style="color:var(--color-secondary)">Cü</i></div>
        <span class="cf-label" style="font-family:'Poppins',sans-serif">Clinüx<span style="color:var(--color-primary)">Flow</span></span>
        <span class="cf-label">Powered by YAXB</span>
      </div>
      <p class="cf-label">© 2026 YAXB Technologies Pvt. Ltd. All rights reserved.</p>
      <div class="flex gap-4 text-sm"><a href="#" class="hover:text-white transition-colors">Privacy</a><a href="#" class="hover:text-white transition-colors">Terms</a></div>
    </div>
  </footer>

  <!-- SPEC-20: General category thread hosts Register/Login/Forgot Password/Change Password —
       Index.vue didn't mount Cübo at all before this. Floating FAB badge — "Try Guided Setup"
       navigates to /ai-engine (Cübo's own 3-pane home) instead of expanding this widget in place. -->
  <Cubo page-context="ClinüxFlow — register, sign in, or manage your account." />
</template>

<style>
@keyframes bounce { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-5px) } }
</style>
