<script setup>
// Ported from clinixflow's public/clinic-home.html — the public microsite generated from the
// published onboarding profile. This page has always had its own self-contained design system
// (--brand/--bg/--text CSS variables, distinct from the shared --cf-*/--color-* tokens every
// other page uses) — kept as a scoped <style> block here for the same reason: nothing outside
// this page should be affected by, e.g., its own .nav-link/.btn class definitions.
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useLiveQuery } from '@tanstack/vue-db';
import { useOnboardingStore } from '../stores/onboarding.js';
import { useAuthStore } from '../stores/auth.js';
import { useClinicalStore } from '../stores/clinical.js';
import { useThemeStore } from '../stores/theme.js';
import { publicAppointments } from '../data/collections/publicAppointments.js';
import FrontDesk from './FrontDesk.vue';
import ConsultationDesk from './ConsultationDesk.vue';
import Checkout from './Checkout.vue';

const onboarding = useOnboardingStore();
const auth = useAuthStore();
const clinical = useClinicalStore();
const theme = useThemeStore();
const router = useRouter();

// Front Desk/Consultation Desk/Checkout used to be their own routed pages — now mounted
// directly here as internally-switched views (see
// clinux-frontdesk-consultation-checkout-as-clinic-home-components memory note): one persistent
// /clinic-home URL, pure in-memory state, no query-param/hash deep-linking to a specific step —
// confirmed with the user. Values reuse clinical.recordVisit()'s own page-key strings
// ('front-desk' | 'consultation-desk' | 'checkout') so getLastVisitedPage()'s stored value can
// drive this directly with no extra mapping. Each embedded view is v-if'd, not v-show'd — mounts/
// unmounts on switch just like today's actual page navigation did, confirmed with the user, so
// there's never more than one of them (and one Cubo instance) alive at a time, avoiding any risk
// from LForms' documented "one live form instance per page" assumption.
const clinicView = ref('public'); // 'public' | 'front-desk' | 'consultation-desk' | 'checkout'

// Front Desk/Consultation Desk/Checkout kept requiresAuth:true on their own routes before this
// merge — preserved as an explicit check now that there's no route boundary to enforce it
// (confirmed with the user): a signed-out visitor clicking through lands on / instead of
// silently reaching real clinic-operations UI.
function openClinicView(view) {
  if (!auth.currentUser) { router.push('/'); return; }
  clinicView.value = view;
}

const DEMO_CLINIC = {
  name: 'Apollo Diagnostics', type: 'Diagnostic Centre', tagline: 'Your trusted diagnostic partner',
  address: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001', country: 'India',
  phone: '+91 80 2345 6789', whatsapp: '+91 98765 43210', email: 'info@apollodiag.com',
  brandColor: '#00D4B2', slug: 'apollo-diagnostics',
  staff: [
    { id: 'S1', name: 'Dr. Priya Menon', role: 'Doctor', specialty: 'Cardiology', qualification: 'MBBS, MD', bio: '15 years of clinical experience in cardiology.', color: '#3B82F6' },
    { id: 'S2', name: 'Dr. Arjun Sharma', role: 'Radiologist', specialty: 'Radiology', qualification: 'MBBS, DNB', bio: 'Expert in diagnostic imaging and interventional radiology.', color: '#8B5CF6' },
    { id: 'S3', name: 'Ms. Riya Singh', role: 'Nurse', specialty: 'ICU Care', qualification: 'BSc Nursing', bio: 'Senior nurse with critical care specialisation.', color: '#EF4444' },
  ],
  services: [
    { id: 'V1', name: 'General Consultation', category: 'General', duration: '30 min', fee: '500', description: 'Comprehensive consultation with our specialists.' },
    { id: 'V2', name: 'ECG', category: 'Diagnostic', duration: '20 min', fee: '300', description: '12-lead electrocardiogram with interpretation.' },
    { id: 'V3', name: 'Chest X-Ray', category: 'Diagnostic', duration: '15 min', fee: '800', description: 'Digital chest radiograph with radiologist report.' },
    { id: 'V4', name: 'Blood Panel', category: 'Diagnostic', duration: '10 min', fee: '1200', description: 'Complete blood count, lipid profile and metabolic panel.' },
  ],
  hours: [
    { day: 'Monday', open: true, from: '08:00', to: '20:00' },
    { day: 'Tuesday', open: true, from: '08:00', to: '20:00' },
    { day: 'Wednesday', open: true, from: '08:00', to: '20:00' },
    { day: 'Thursday', open: true, from: '08:00', to: '20:00' },
    { day: 'Friday', open: true, from: '08:00', to: '20:00' },
    { day: 'Saturday', open: true, from: '09:00', to: '16:00' },
    { day: 'Sunday', open: false, from: '', to: '' },
  ],
  consents: [{ enabled: true }, { enabled: true }, { enabled: true }],
  apptConfig: { onlineBooking: true },
};

// Demo data for when no onboarding has been done yet — same fallback the original had.
const clinic = computed(() => (onboarding.publishedClinic?.name ? onboarding.publishedClinic : DEMO_CLINIC));

// isAdmin: was clinixflow's own fuzzy heuristic (clinicName prefix match OR just having an
// email) — kept as-is since it's what the original did, even though it's a loose check.
const isAdmin = computed(() => {
  const u = auth.currentUser;
  if (!u || !clinic.value.name) return false;
  return (u.clinicName && u.clinicName.toLowerCase().includes(clinic.value.name.toLowerCase().substring(0, 6))) || !!u.email;
});

if (clinic.value.brandColor) {
  document.documentElement.style.setProperty('--brand', clinic.value.brandColor);
}

// Admin-gated "Live Now" dashboard (Active Sessions / Upcoming Appointments, switchable) — this
// route has no requiresAuth (confirmed in router/index.js), so isAdmin here is a cosmetic/
// defense-in-depth gate only, not real access control. Session cards deliberately show no
// patient name or chief complaint (see template) — this can render on a nominally-public route.
// Always shown for admins now (not gated on "has at least one session") — a stable dashboard
// section rather than an ephemeral banner; each tab has its own empty state.
const activeSessions = computed(() => clinical.listActiveSessions());
const showLiveNow = computed(() => isAdmin.value);
const liveNowTab = ref('sessions'); // 'sessions' | 'appointments'

// Same useLiveQuery reactivity fix as clinical.js's getEncounter()/listActiveSessions() (see
// clinux-consultation-clinichome-frontdesk-fixes memory note) — a plain publicAppointments
// .toArray() read wrapped in a computed() would only ever evaluate once per component lifetime.
const { data: allPublicAppointments } = useLiveQuery((q) => q.from({ a: publicAppointments }));
const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
const appointmentsWindow = computed(() => {
  const now = Date.now();
  return allPublicAppointments.value
    .filter((a) => a.clinic === clinic.value.name)
    .filter((a) => {
      const d = new Date(a.date).getTime();
      return !Number.isNaN(d) && Math.abs(d - now) <= TEN_DAYS_MS;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
});

// Profile dropdown — same pattern as Index.vue's own user-menu-anchor (see
// clinux-unified-header-and-home-routing memory note), reusing a plain document listener for
// outside-click close rather than Index.vue's vestigial (unregistered, no-op) v-click-outside
// directive.
const userMenuOpen = ref(false);
function closeUserMenuOnOutsideClick(e) {
  if (!e.target.closest('.user-menu-anchor')) userMenuOpen.value = false;
}
onMounted(() => document.addEventListener('click', closeUserMenuOnOutsideClick));
onUnmounted(() => document.removeEventListener('click', closeUserMenuOnOutsideClick));

function sessionRef(id) {
  return id.slice(-4).toUpperCase();
}

function timeSince(savedAt) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(savedAt).getTime()) / 60000));
  if (mins < 60) return mins + 'm ago';
  return Math.round(mins / 60) + 'h ago';
}

function resumeToSession(session) {
  clinical.setActive(session.id);
  openClinicView(clinical.getLastVisitedPage(session.id) || 'front-desk');
}

const apptModal = ref(false);
const toast = ref({ show: false, msg: '' });
let toastTimer = null;
function showToast(msg) {
  toast.value = { show: true, msg };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value.show = false), 3500);
}

const apptForm = reactive({ name: '', phone: '', email: '', date: '', service: '', doctor: '', notes: '' });
const msgForm = reactive({ name: '', email: '', msg: '' });

// Still used by the #hours section's full weekly table — the hero's own "Today's Hours" card
// (which also used todayHours/todayStatus/isOpenNow/openDays) is gone now, replaced by an
// experts list, so those 4 were removed as dead code.
const allHours = computed(() => {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  return (clinic.value.hours || []).map((r) => ({ ...r, isToday: r.day === today }));
});
const contactItems = computed(() => [
  { label: 'Phone', icon: 'fas fa-phone', value: clinic.value.phone, href: `tel:${clinic.value.phone}` },
  { label: 'WhatsApp', icon: 'fab fa-whatsapp', value: clinic.value.whatsapp, href: `https://wa.me/${clinic.value.whatsapp?.replace(/\D/g, '')}` },
  { label: 'Email', icon: 'fas fa-envelope', value: clinic.value.email, href: `mailto:${clinic.value.email}` },
  { label: 'Website', icon: 'fas fa-globe', value: clinic.value.website, href: clinic.value.website },
  { label: 'Address', icon: 'fas fa-map-marker-alt', value: [clinic.value.address, clinic.value.city, clinic.value.state].filter(Boolean).join(', '), href: `https://maps.google.com?q=${encodeURIComponent([clinic.value.address, clinic.value.city].join(', '))}` },
].filter((c) => c.value));

function submitAppt() {
  publicAppointments.insert({ ...apptForm, id: 'A-' + Date.now(), clinic: clinic.value.name, submittedAt: new Date().toISOString() });
  apptModal.value = false;
  Object.assign(apptForm, { name: '', phone: '', email: '', date: '', service: '', doctor: '', notes: '' });
  showToast('Appointment request submitted! We will confirm shortly.');
}

function sendMessage() {
  showToast("Message sent! We'll get back to you within 24 hours.");
  Object.assign(msgForm, { name: '', email: '', msg: '' });
}
</script>

<template>
  <div class="cf-toast" v-show="toast.show"><i class="fas fa-check-circle" style="color:var(--brand)"></i><span>{{ toast.msg }}</span></div>

  <div class="modal-bg" v-show="apptModal" @click.self="apptModal = false">
    <div class="modal-panel" @click.stop>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
        <h3 style="font-family:'Poppins',sans-serif;font-weight:700;color:var(--text-strong)"><i class="fas fa-calendar-plus mr-2" style="color:var(--brand)"></i>Book an Appointment</h3>
        <button @click="apptModal = false" style="background:transparent;border:none;cursor:pointer;color:var(--text);font-size:1rem"><i class="fas fa-times"></i></button>
      </div>
      <form @submit.prevent="submitAppt()" style="display:flex;flex-direction:column;gap:.875rem">
        <div><label class="appt-label">Your Full Name *</label><input class="appt-input" v-model="apptForm.name" placeholder="Arjun Verma" required /></div>
        <div><label class="appt-label">Phone Number *</label><input class="appt-input" v-model="apptForm.phone" placeholder="+91 9876543210" required /></div>
        <div><label class="appt-label">Email</label><input class="appt-input" type="email" v-model="apptForm.email" placeholder="arjun@email.com" /></div>
        <div><label class="appt-label">Preferred Date *</label><input class="appt-input" type="date" v-model="apptForm.date" required /></div>
        <div>
          <label class="appt-label">Service</label>
          <select class="appt-input" v-model="apptForm.service">
            <option value="">Select service…</option>
            <option v-for="s in clinic.services" :key="s.id" :value="s.name">{{ s.name + (s.fee ? ' — ₹' + s.fee : '') }}</option>
            <option v-show="!clinic.services?.length" value="General Consultation">General Consultation</option>
          </select>
        </div>
        <div>
          <label class="appt-label">Doctor</label>
          <select class="appt-input" v-model="apptForm.doctor">
            <option value="">Any available</option>
            <option v-for="s in clinic.staff?.filter((x) => x.role === 'Doctor' || x.role === 'Radiologist')" :key="s.id" :value="s.name">{{ s.name }}</option>
          </select>
        </div>
        <div><label class="appt-label">Message</label><textarea class="appt-input" v-model="apptForm.notes" rows="2" placeholder="Any notes for the clinic…" style="resize:vertical"></textarea></div>
        <div style="display:flex;gap:.625rem;margin-top:.25rem">
          <button type="button" class="btn btn-outline" @click="apptModal = false" style="flex:1;justify-content:center">Cancel</button>
          <button type="submit" class="btn btn-brand" style="flex:1;justify-content:center"><i class="fas fa-check"></i>Confirm Booking</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Public marketing content — hidden (not unmounted; nothing here has side effects worth
       avoiding) while a clinic-operations view is active below. The old top active-sessions-
       strip is gone — redundant with the richer "Live Now" section below the hero, which covers
       the same admin-only session list plus upcoming appointments. -->
  <div v-show="clinicView === 'public'">
  <nav class="site-nav">
    <div class="nav-inner">
      <div class="nav-logo">
        <div v-if="clinic.logoUrl" style="height:36px;width:auto"><img :src="clinic.logoUrl" style="height:36px;width:auto;border-radius:.375rem" @error="clinic.logoUrl = ''" /></div>
        <div v-else style="width:36px;height:36px;border-radius:.625rem;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.9rem;font-family:'Poppins',sans-serif" :style="`background:${clinic.brandColor || '#00D4B2'}22;color:${clinic.brandColor || '#00D4B2'}`">{{ (clinic.name || 'C').charAt(0).toUpperCase() }}</div>
        <div>
          <p style="font-family:'Poppins',sans-serif;font-weight:700;font-size:.95rem;color:var(--text-strong)">{{ clinic.name || 'Your Clinic' }}</p>
          <p style="font-size:.65rem;color:var(--brand);font-weight:600;font-family:'Poppins',sans-serif;margin-top:-.1rem">{{ clinic.type || 'Healthcare' }}</p>
        </div>
      </div>
      <div class="nav-links">
        <a href="#team" class="nav-link" v-show="clinic.staff?.length">Team</a>
        <a href="#services" class="nav-link" v-show="clinic.services?.length">Services</a>
        <a href="#hours" class="nav-link">Hours</a>
        <a href="#contact" class="nav-link">Contact</a>
      </div>
      <div class="nav-actions">
        <button class="btn btn-brand btn-sm" @click="apptModal = true" v-show="clinic.apptConfig?.onlineBooking !== false"><i class="fas fa-calendar-plus"></i>Book</button>
        <button class="icon-btn-round" @click="theme.toggle()" :title="theme.isDark ? 'Switch to light mode' : 'Switch to dark mode'">
          <i :class="theme.isDark ? 'fas fa-sun' : 'fas fa-moon'"></i>
        </button>
        <!-- Matches Index.vue's own header: Sign In/Register when signed out, a profile
             dropdown when signed in — admin-only actions (Front Desk/Edit Profile/Settings/
             AI Engine) fold in here instead of the old always-visible .admin-bar strip. -->
        <div v-if="!auth.currentUser" style="display:flex;align-items:center;gap:.5rem">
          <RouterLink to="/" class="btn btn-outline btn-xs">Sign In</RouterLink>
        </div>
        <div v-else class="relative user-menu-anchor" style="position:relative">
          <button @click="userMenuOpen = !userMenuOpen" class="icon-btn-round" style="background:var(--brand);color:#fff;font-weight:700;font-family:'Poppins',sans-serif" :title="auth.currentUser.clinicName">
            <span>{{ auth.currentUser.clinicName.charAt(0).toUpperCase() }}</span>
          </button>
          <div v-show="userMenuOpen" class="user-menu">
            <div class="user-menu-header">
              <p style="font-size:.75rem;font-weight:700;color:var(--text-strong)" class="truncate">{{ auth.currentUser.clinicName }}</p>
              <p style="font-size:.7rem;color:var(--text)" class="truncate">{{ auth.currentUser.email }}</p>
            </div>
            <template v-if="isAdmin">
              <button class="user-menu-item" @click="openClinicView('front-desk'); userMenuOpen = false"><i class="fas fa-user-clock" style="color:var(--brand)"></i>Front Desk</button>
              <RouterLink to="/onboarding" class="user-menu-item" @click="userMenuOpen = false"><i class="fas fa-pen" style="color:var(--brand)"></i>Edit Profile</RouterLink>
              <RouterLink to="/designer" class="user-menu-item" @click="userMenuOpen = false"><i class="fas fa-cog" style="color:var(--brand)"></i>Settings</RouterLink>
              <RouterLink to="/ai-engine" class="user-menu-item" @click="userMenuOpen = false"><i class="fas fa-brain" style="color:var(--brand)"></i>AI Engine</RouterLink>
            </template>
            <button class="user-menu-item" style="color:#EF4444" @click="auth.logout(); userMenuOpen = false"><i class="fas fa-sign-out-alt"></i>Sign Out</button>
          </div>
        </div>
        <RouterLink to="/" class="btn btn-outline btn-xs"><i class="fas fa-home"></i></RouterLink>
      </div>
    </div>
  </nav>

  <section class="hero">
    <div class="hero-bg">
      <div class="hero-ring" style="width:800px;height:800px;top:50%;left:55%;transform:translate(-50%,-50%)"></div>
      <div class="hero-ring" style="width:550px;height:550px;top:50%;left:55%;transform:translate(-50%,-50%);border-color:rgba(0,212,178,.16)"></div>
      <div class="hero-orb" style="width:500px;height:500px;top:10%;right:-5%"></div>
    </div>
    <div class="hero-content">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:3rem;align-items:center" class="hero-grid">
        <div>
          <span class="eyebrow">{{ clinic.type || 'Healthcare Partner' }}</span>
          <h1 style="font-size:3rem;font-weight:800;color:var(--text-strong);line-height:1.1;letter-spacing:-1.5px;margin-bottom:1rem">
            {{ clinic.name || 'Your Clinic' }}<br>
            <span v-if="!clinic.tagline" class="grad-text">Trusted Care,<br>Every Visit.</span>
            <span v-else style="background:linear-gradient(135deg,#00D4B2 0%,#0A7A6E 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">{{ clinic.tagline }}</span>
          </h1>
          <p style="font-size:1rem;color:var(--text);line-height:1.75;margin-bottom:2rem;max-width:480px">
            <span v-show="clinic.city || clinic.address">{{ `Located in ${clinic.city || clinic.address} — ` }}</span>
            <span>providing compassionate, FHIR-compliant healthcare powered by ClinixFlow AI.</span>
          </p>
          <div style="display:flex;flex-wrap:wrap;gap:.875rem">
            <button class="btn btn-brand" @click="apptModal = true" style="font-size:1rem;padding:.875rem 2rem"><i class="fas fa-calendar-plus"></i>Book Appointment</button>
            <button class="btn btn-outline" style="font-size:.95rem;padding:.875rem 1.75rem" @click="openClinicView('front-desk')"><i class="fas fa-stethoscope"></i>Front Desk</button>
          </div>
        </div>
        <div>
          <!-- Meet Our Experts — replaces the old Today's Hours card (redundant with the
               dedicated #hours section further down, which has the full weekly table). -->
          <div class="cf-card" style="border-radius:1.25rem;padding:1.75rem;box-shadow:0 20px 50px rgba(0,0,0,.08)">
            <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:1.25rem;padding-bottom:1rem;border-bottom:1px solid var(--border)">
              <div style="width:40px;height:40px;border-radius:.625rem;display:flex;align-items:center;justify-content:center" :style="`background:${clinic.brandColor || '#00D4B2'}22`"><i class="fas fa-user-doctor" :style="`color:${clinic.brandColor || '#00D4B2'}`"></i></div>
              <div><p style="font-weight:700;font-size:.95rem;color:var(--text-strong);font-family:'Poppins',sans-serif">Meet Our Experts</p><p style="font-size:.75rem;color:var(--text)">{{ clinic.staff?.length || 0 }} care team member{{ clinic.staff?.length === 1 ? '' : 's' }}</p></div>
            </div>
            <div v-if="clinic.staff?.length" style="display:flex;flex-direction:column;gap:1rem">
              <div v-for="s in clinic.staff.slice(0, 4)" :key="s.id" style="display:flex;align-items:center;gap:.75rem">
                <div class="expert-avatar-sm" :style="`background:${s.color || clinic.brandColor || '#00D4B2'}18;color:${s.color || clinic.brandColor || '#00D4B2'}`">{{ s.name?.charAt(0)?.toUpperCase() }}</div>
                <div style="min-width:0">
                  <p style="font-weight:700;font-size:.85rem;color:var(--text-strong);font-family:'Poppins',sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ s.name }}</p>
                  <p style="font-size:.75rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ s.role }}{{ s.specialty ? ' · ' + s.specialty : '' }}</p>
                </div>
              </div>
            </div>
            <p v-else style="font-size:.85rem;color:var(--text);padding:.5rem 0">Care team details coming soon.</p>
            <a href="#team" class="btn btn-outline btn-xs" style="margin-top:1.25rem;width:100%;justify-content:center" v-show="clinic.staff?.length > 4">View Full Team</a>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Admin-only, PII-masked (Active Sessions tab: no patient name or chief complaint) — this
       route has no requiresAuth, so isAdmin/showLiveNow are cosmetic/defense-in-depth gates
       only, not real access control. Two switchable tabs instead of a single fixed list — the
       old "About Us" section (with its redundant address block, already shown in Contact below)
       and the FHIR/AI/Privacy/Online-booking feature cards are gone. -->
  <section id="sessions" class="section section-alt" v-show="showLiveNow">
    <div class="container">
      <div class="section-header">
        <span class="eyebrow">Live Now</span>
        <div class="teal-line" style="margin:0 auto .75rem"></div>
        <h2 class="section-title">{{ liveNowTab === 'sessions' ? 'Active Sessions' : 'Upcoming Appointments' }}</h2>
        <p class="section-sub" style="max-width:520px;margin:0 auto">{{ liveNowTab === 'sessions' ? 'Resume any visit already in progress.' : 'Requests booked for the next (or past) 10 days.' }}</p>
        <div class="live-now-tabs">
          <button :class="liveNowTab === 'sessions' ? 'active' : ''" @click="liveNowTab = 'sessions'">
            <i class="fas fa-user-clock"></i>Active Sessions<span class="badge badge-brand" v-show="activeSessions.length">{{ activeSessions.length }}</span>
          </button>
          <button :class="liveNowTab === 'appointments' ? 'active' : ''" @click="liveNowTab = 'appointments'">
            <i class="fas fa-calendar-days"></i>Appointments<span class="badge badge-brand" v-show="appointmentsWindow.length">{{ appointmentsWindow.length }}</span>
          </button>
        </div>
      </div>

      <div v-show="liveNowTab === 'sessions'">
        <p v-if="activeSessions.length === 0" style="text-align:center;font-size:.85rem;color:var(--text)">No visits in progress right now.</p>
        <div v-else class="sessions-scroll">
          <div v-for="s in activeSessions" :key="s.id" class="session-card" @click="resumeToSession(s)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
              <span class="badge badge-brand">#{{ sessionRef(s.id) }}</span>
              <span v-if="s.priority === 'Emergency'" class="badge" style="background:#fee2e2;color:#b91c1c">Emergency</span>
            </div>
            <p style="font-weight:700;font-size:.95rem;color:var(--text-strong);font-family:'Poppins',sans-serif;margin-bottom:.3rem">{{ s.status }}</p>
            <p style="font-size:.78rem;color:var(--text)"><i class="fas fa-clock mr-1.5"></i>{{ timeSince(s.savedAt) }}</p>
            <button class="btn btn-outline btn-xs" style="margin-top:1rem;width:100%;justify-content:center">Resume</button>
          </div>
        </div>
      </div>

      <div v-show="liveNowTab === 'appointments'">
        <p v-if="appointmentsWindow.length === 0" style="text-align:center;font-size:.85rem;color:var(--text)">No appointment requests within 10 days of today.</p>
        <div v-else class="sessions-scroll">
          <div v-for="appt in appointmentsWindow" :key="appt.id" class="session-card">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
              <span class="badge badge-brand">{{ new Date(appt.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }}</span>
            </div>
            <p style="font-weight:700;font-size:.95rem;color:var(--text-strong);font-family:'Poppins',sans-serif;margin-bottom:.3rem">{{ appt.name }}</p>
            <p style="font-size:.78rem;color:var(--text)">{{ appt.service || 'General Consultation' }}</p>
            <p v-show="appt.doctor" style="font-size:.78rem;color:var(--text)"><i class="fas fa-user-doctor mr-1.5"></i>{{ appt.doctor }}</p>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section id="team" class="section" v-show="clinic.staff?.length">
    <div class="container">
      <div class="section-header">
        <span class="eyebrow">Care Team</span>
        <div class="teal-line" style="margin:0 auto .75rem"></div>
        <h2 class="section-title">Our Medical Experts</h2>
        <p class="section-sub" style="max-width:520px;margin:0 auto">Highly trained professionals dedicated to your health and wellbeing.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1.25rem" class="staff-grid">
        <div v-for="s in clinic.staff" :key="s.id" class="staff-card">
          <div class="staff-avatar" :style="`background:${s.color || clinic.brandColor || '#00D4B2'}18;color:${s.color || clinic.brandColor || '#00D4B2'}`">{{ s.name?.charAt(0)?.toUpperCase() }}</div>
          <div style="padding:1.125rem">
            <p style="font-weight:700;font-size:.95rem;color:var(--text-strong);font-family:'Poppins',sans-serif;margin-bottom:.3rem">{{ s.name }}</p>
            <div style="display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.625rem">
              <span class="badge badge-brand">{{ s.role }}</span>
              <span v-show="s.specialty" class="badge badge-navy">{{ s.specialty }}</span>
            </div>
            <p v-show="s.qualification" style="font-size:.75rem;color:var(--text);margin-bottom:.35rem"><i class="fas fa-graduation-cap mr-1.5" :style="`color:${clinic.brandColor || '#00D4B2'}`"></i><span>{{ s.qualification }}</span></p>
            <p v-show="s.bio" style="font-size:.78rem;color:var(--text);line-height:1.5;margin-top:.5rem">{{ s.bio?.length > 100 ? s.bio.substring(0, 100) + '…' : s.bio }}</p>
            <button class="btn btn-brand btn-xs" @click="apptModal = true; apptForm.doctor = s.name" style="margin-top:1rem;width:100%;justify-content:center"><i class="fas fa-calendar-check"></i>Book with Dr.</button>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section id="services" class="section section-alt" v-show="clinic.services?.length">
    <div class="container">
      <div class="section-header">
        <span class="eyebrow">What We Offer</span>
        <div class="teal-line" style="margin:0 auto .75rem"></div>
        <h2 class="section-title">Our Services</h2>
        <p class="section-sub" style="max-width:520px;margin:0 auto">Comprehensive care tailored to your needs at transparent, affordable rates.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1.125rem" class="services-grid">
        <div v-for="svc in clinic.services" :key="svc.id" class="service-card">
          <div style="width:44px;height:44px;border-radius:.75rem;display:flex;align-items:center;justify-content:center;margin-bottom:1rem" :style="`background:${clinic.brandColor || '#00D4B2'}12`"><i class="fas fa-stethoscope" :style="`color:${clinic.brandColor || '#00D4B2'}`"></i></div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.3rem">
            <h4 style="font-weight:700;font-size:.95rem;color:var(--text-strong);font-family:'Poppins',sans-serif">{{ svc.name }}</h4>
            <span class="badge badge-brand">{{ svc.category }}</span>
          </div>
          <p v-show="svc.description" style="font-size:.8rem;color:var(--text);margin-bottom:.75rem;line-height:1.5">{{ svc.description }}</p>
          <div style="display:flex;align-items:center;justify-content:space-between;padding-top:.75rem;border-top:1px solid var(--border)">
            <div><p v-show="svc.duration" style="font-size:.75rem;color:var(--text)"><i class="far fa-clock mr-1" :style="`color:${clinic.brandColor || '#00D4B2'}`"></i><span>{{ svc.duration }}</span></p></div>
            <div v-show="svc.fee"><p style="font-size:1rem;font-weight:800;font-family:'Poppins',sans-serif" :style="`color:${clinic.brandColor || '#00D4B2'}`">{{ '₹' + svc.fee }}</p></div>
          </div>
          <button class="btn btn-brand btn-xs" @click="apptModal = true; apptForm.service = svc.name" style="margin-top:.875rem;width:100%;justify-content:center"><i class="fas fa-calendar-plus"></i>Book Now</button>
        </div>
      </div>
    </div>
  </section>

  <section id="locations" class="section section-alt" v-show="clinic.locations?.length">
    <div class="container">
      <div class="section-header">
        <span class="eyebrow">Find Us</span>
        <div class="teal-line" style="margin:0 auto .75rem"></div>
        <h2 class="section-title">Our Locations</h2>
        <p class="section-sub" style="max-width:520px;margin:0 auto">Visit us at any of our branches.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1.125rem">
        <div v-for="loc in clinic.locations" :key="loc.id" class="service-card">
          <div style="width:44px;height:44px;border-radius:.75rem;display:flex;align-items:center;justify-content:center;margin-bottom:1rem" :style="`background:${clinic.brandColor || '#00D4B2'}12`"><i class="fas fa-map-marker-alt" :style="`color:${clinic.brandColor || '#00D4B2'}`"></i></div>
          <h4 style="font-weight:700;font-size:.95rem;color:var(--text-strong);font-family:'Poppins',sans-serif;margin-bottom:.4rem">{{ loc.name }}</h4>
          <p v-show="loc.address" style="font-size:.8rem;color:var(--text);margin-bottom:.35rem;line-height:1.5">{{ loc.address }}</p>
          <p v-show="loc.phone" style="font-size:.8rem;color:var(--text)"><i class="fas fa-phone mr-1.5" :style="`color:${clinic.brandColor || '#00D4B2'}`"></i><span>{{ loc.phone }}</span></p>
        </div>
      </div>
    </div>
  </section>

  <section id="hours" class="section">
    <div class="container">
      <div class="two-col-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:3rem">
        <div>
          <span class="eyebrow">Opening Times</span>
          <div class="teal-line"></div>
          <h2 style="font-size:1.75rem;font-weight:700;color:var(--text-strong);margin-bottom:1.5rem">Office Hours</h2>
          <div class="cf-card" style="border-radius:1.125rem;padding:1.5rem">
            <table class="hours-table" style="width:100%">
              <tr v-for="row in allHours" :key="row.day" :style="row.isToday ? `border-left:3px solid ${clinic.brandColor || '#00D4B2'};padding-left:.5rem` : ''">
                <td style="padding:.625rem .75rem .625rem 0;font-weight:600;font-family:'Poppins',sans-serif;font-size:.88rem" :style="row.isToday ? `color:${clinic.brandColor || '#00D4B2'}` : 'color:var(--text-strong)'">{{ row.day }}</td>
                <td style="text-align:right;font-size:.85rem" v-show="row.open" :style="`color:${clinic.brandColor || '#00D4B2'};font-weight:600`">{{ row.from + ' – ' + row.to }}</td>
                <td style="text-align:right;font-size:.82rem;color:var(--text)" v-show="!row.open">Closed</td>
              </tr>
            </table>
          </div>
        </div>
        <div id="contact">
          <span class="eyebrow">Reach Us</span>
          <div class="teal-line"></div>
          <h2 style="font-size:1.75rem;font-weight:700;color:var(--text-strong);margin-bottom:1.5rem">Contact Information</h2>
          <!-- .cf-card wrapper (matching Office Hours' own card, left) is what keeps the two
               columns visually aligned — this list used to start as plain unwrapped rows, so it
               sat flush against the heading while Office Hours' card started with visible
               padding/border, making the two columns look misaligned. -->
          <div class="cf-card" style="border-radius:1.125rem;padding:1.5rem;margin-bottom:1.5rem;display:flex;flex-direction:column;gap:1rem">
            <div v-for="contact in contactItems" :key="contact.label" style="display:flex;align-items:center;gap:.875rem" v-show="contact.value">
              <div style="width:40px;height:40px;border-radius:.625rem;display:flex;align-items:center;justify-content:center;flex-shrink:0" :style="`background:${clinic.brandColor || '#00D4B2'}12`"><i :class="contact.icon" :style="`color:${clinic.brandColor || '#00D4B2'};font-size:.9rem`"></i></div>
              <div><p style="font-size:.72rem;color:var(--text);font-weight:600;font-family:'Poppins',sans-serif">{{ contact.label }}</p><a :href="contact.href" style="font-size:.9rem;font-weight:600;color:var(--text-strong)">{{ contact.value }}</a></div>
            </div>
          </div>
          <div class="cf-card" style="border-radius:1rem;padding:1.5rem">
            <h4 style="font-family:'Poppins',sans-serif;font-weight:700;font-size:.95rem;color:var(--text-strong);margin-bottom:1rem">Send a Message</h4>
            <form @submit.prevent="sendMessage()" style="display:flex;flex-direction:column;gap:.75rem">
              <div><label class="appt-label">Name</label><input class="appt-input" v-model="msgForm.name" placeholder="Your name" required /></div>
              <div><label class="appt-label">Email</label><input class="appt-input" type="email" v-model="msgForm.email" placeholder="you@email.com" required /></div>
              <div><label class="appt-label">Message</label><textarea class="appt-input" v-model="msgForm.msg" rows="3" placeholder="How can we help you?" style="resize:vertical" required></textarea></div>
              <button type="submit" class="btn btn-brand" style="width:100%;justify-content:center"><i class="fas fa-paper-plane"></i>Send Message</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  </section>

  <footer style="background:var(--color-secondary);padding:2.5rem 0;margin-bottom:1.5rem">
    <div class="container" style="display:flex;flex-direction:column;align-items:center;gap:1rem;text-align:center">
      <div style="display:flex;align-items:center;gap:.625rem">
        <div style="width:28px;height:28px;border-radius:.4rem;display:flex;align-items:center;justify-content:center;background:rgba(0,212,178,.15)"><span style="color:#00D4B2;font-weight:800;font-size:.65rem;font-family:'Poppins',sans-serif">CÜ</span></div>
        <span style="font-family:'Poppins',sans-serif;font-weight:700;color:#fff;font-size:.9rem">Clinix<span style="color:#00D4B2">Flow</span></span>
      </div>
      <p style="font-size:.8rem;color:rgba(255,255,255,.5)">{{ `© ${new Date().getFullYear()} ${clinic.name || 'Your Clinic'}. All rights reserved.` }}</p>
      <p style="font-size:.75rem;color:rgba(255,255,255,.4)">Powered by <RouterLink to="/" style="color:#00D4B2">ClinixFlow</RouterLink> · FHIR R4 Compliant Healthcare Platform</p>
      <div style="display:flex;gap:1.5rem;margin-top:.25rem">
        <a href="#team" style="font-size:.78rem;color:rgba(255,255,255,.5)">Team</a>
        <a href="#services" style="font-size:.78rem;color:rgba(255,255,255,.5)">Services</a>
        <a href="#contact" style="font-size:.78rem;color:rgba(255,255,255,.5)">Contact</a>
      </div>
    </div>
  </footer>
  </div>
  <!-- ── end public marketing content ── -->

  <!-- ── Clinic operations (Front Desk / Consultation Desk / Checkout) ──
       Mounted/unmounted on switch (v-if), not kept alive as background tabs — confirmed with
       the user. Mirrors App.vue's own min-h-screen flex-col + sticky-nav shell, since each of
       these 3 components' own root assumes exactly that (a full-height flex ancestor), same as
       when they were reached via their own routes under App.vue's <RouterView/>. -->
  <div v-show="clinicView !== 'public'" style="min-height:100vh;display:flex;flex-direction:column">
    <!-- Branded header (clinic logo/name, matching .site-nav's own .nav-logo treatment) — was
         previously just the bare Clinic Home/Front Desk/Consultation Desk/Checkout nav buttons
         with no clinic identity shown at all, unlike every other page. -->
    <nav class="cf-nav ops-nav" style="position:sticky;top:0;z-index:40">
      <div style="max-width:1600px;margin:0 auto;padding:0 1.5rem;height:56px;display:flex;align-items:center;justify-content:space-between;gap:1rem">
        <div style="display:flex;align-items:center;gap:.75rem;min-width:0">
          <div v-if="clinic.logoUrl" style="height:28px;width:auto;flex-shrink:0"><img :src="clinic.logoUrl" style="height:28px;width:auto;border-radius:.3rem" /></div>
          <div v-else style="width:28px;height:28px;border-radius:.5rem;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.75rem;font-family:'Poppins',sans-serif;flex-shrink:0" :style="`background:${clinic.brandColor || '#00D4B2'}22;color:${clinic.brandColor || '#00D4B2'}`">{{ (clinic.name || 'C').charAt(0).toUpperCase() }}</div>
          <span style="font-family:'Poppins',sans-serif;font-weight:700;font-size:.85rem;color:var(--cf-text-strong);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ clinic.name || 'Your Clinic' }}</span>
          <span style="width:1px;height:20px;background:var(--cf-border);flex-shrink:0"></span>
          <button class="btn-ghost" style="white-space:nowrap" @click="clinicView = 'public'"><i class="fas fa-arrow-left" style="margin-right:.35rem"></i>Clinic Home</button>
        </div>
        <div style="display:flex;align-items:center;gap:.5rem;flex-shrink:0">
          <button class="btn-outline" :class="clinicView === 'front-desk' ? 'btn-teal' : ''" @click="openClinicView('front-desk')"><i class="fas fa-house" style="margin-right:.35rem"></i>Front Desk</button>
          <button class="btn-outline" :class="clinicView === 'consultation-desk' ? 'btn-teal' : ''" @click="openClinicView('consultation-desk')"><i class="fas fa-stethoscope" style="margin-right:.35rem"></i>Consultation Desk</button>
          <button v-if="clinical.activeEncounterId" class="btn-outline" :class="clinicView === 'checkout' ? 'btn-teal' : ''" @click="openClinicView('checkout')"><i class="fas fa-receipt" style="margin-right:.35rem"></i>Checkout</button>
        </div>
      </div>
    </nav>
    <!-- flex-direction:column (not row) — matches App.vue's own min-h-screen flex-col shell
         these 3 components' templates were originally rendered inside. Found during live
         verification: ConsultationDesk.vue's template has multiple flow-participating top-level
         siblings when its v-else branch is active (top bar + two-pane content + bottom bar, its
         toast/drawer/modal siblings are all position:fixed so they don't count) — a plain
         display:flex row squeezed all three into one horizontal strip instead of stacking them.
         FrontDesk.vue/Checkout.vue only ever have ONE such sibling, so the same bug was invisible
         there (a single flex item renders the same regardless of flex-direction).

         max-width + margin:0 auto (not full-bleed edge-to-edge) — matches Index.vue/the public
         ClinicHome content's own centered-container convention, which these 3 views previously
         had none of (their two-pane content spanned the entire viewport width with zero side
         margin on wide screens, unlike every other page). Wider than the public page's own
         max-width (1150-1300px) since these host a working two-pane interface (Cübo + form
         content), not marketing copy.

         padding:0 1.5rem alongside the max-width — without it, max-width:1600px alone gives
         zero gutter on every screen narrower than 1600px (i.e. almost all real laptops/monitors:
         1280/1366/1440/1536), reproducing the exact "stretched edge-to-edge" complaint this was
         meant to fix. .container on the public page pairs max-width with this same unconditional
         padding for the same reason — box-sizing:border-box (Tailwind preflight) keeps width:100%
         from overflowing once padding is added. -->
    <div v-if="clinicView === 'front-desk'" style="flex:1;display:flex;flex-direction:column;overflow:hidden;max-width:1600px;margin:0 auto;width:100%;padding:0 1.5rem;box-sizing:border-box">
      <FrontDesk @navigate="clinicView = $event" />
    </div>
    <div v-if="clinicView === 'consultation-desk'" style="flex:1;display:flex;flex-direction:column;overflow:hidden;max-width:1600px;margin:0 auto;width:100%;padding:0 1.5rem;box-sizing:border-box">
      <ConsultationDesk @navigate="clinicView = $event" />
    </div>
    <div v-if="clinicView === 'checkout'" style="flex:1;display:flex;flex-direction:column;overflow:hidden;max-width:1600px;margin:0 auto;width:100%;padding:0 1.5rem;box-sizing:border-box">
      <Checkout @navigate="clinicView = $event" />
    </div>
    <!-- Minimal branded footer — matches the public page having a footer at all, kept to one
         thin strip (not the full marketing footer) since these are dense working screens where
         vertical space actually matters. -->
    <footer class="ops-footer">
      <span>Powered by <RouterLink to="/">ClinixFlow</RouterLink> · FHIR R4 Compliant Healthcare Platform</span>
      <span>{{ `© ${new Date().getFullYear()} ${clinic.name || 'Your Clinic'}` }}</span>
    </footer>
  </div>
</template>

<style scoped>
/* :global since scoped CSS can't target <html> (it's not part of this component's own
   template) — these custom properties need to cascade to every element this page renders. */
:global(:root) {
  --brand:#00D4B2; --brand2:#00B89C;
  --bg:#FAFCFF; --bg-alt:#F0F4F9;
  --text:#475569; --text-strong:#0A2540;
  --border:#CBD5E1;
  --nav-bg:rgba(250,252,255,0.95);
}
:global(.dark) {
  --bg:#080F1C; --bg-alt:#0D1A2E;
  --text:#94A3B8; --text-strong:#E2E8F0;
  --border:#1E3A5F; --nav-bg:rgba(8,15,28,0.96);
}
a { text-decoration:none; color:inherit; }
.brand-accent { color:var(--brand); }
.brand-bg { background:var(--brand); }
.site-nav { position:fixed;top:0;width:100%;background:var(--nav-bg);border-bottom:1px solid var(--border);backdrop-filter:blur(14px);z-index:50;transition:background .3s,border .3s; }
.nav-inner { max-width:1200px;margin:0 auto;padding:0 1.5rem;height:64px;display:flex;align-items:center;justify-content:space-between; }
.nav-logo { display:flex;align-items:center;gap:.625rem; }
.nav-links { display:flex;align-items:center;gap:2rem; }
.nav-link { font-size:.875rem;font-weight:600;color:var(--text);transition:color .15s;cursor:pointer; }
.nav-link:hover { color:var(--brand); }
.nav-actions { display:flex;align-items:center;gap:.625rem; }
.btn { display:inline-flex;align-items:center;gap:.5rem;font-family:'Poppins',sans-serif;font-weight:700;border-radius:.625rem;cursor:pointer;border:none;transition:all .2s;white-space:nowrap; }
.btn-brand { background:var(--brand);color:var(--color-secondary);padding:.7rem 1.5rem;font-size:.9rem; }
.btn-brand:hover { background:var(--brand2);box-shadow:0 8px 24px rgba(0,212,178,.3);transform:translateY(-1px); }
.btn-dark { background:var(--color-secondary);color:#fff;padding:.7rem 1.5rem;font-size:.9rem; }
:global(.dark) .btn-dark { background:var(--brand);color:var(--color-secondary); }
.btn-outline { background:transparent;color:var(--color-secondary);border:1.5px solid var(--color-secondary);padding:.65rem 1.25rem;font-size:.875rem; }
.btn-outline:hover { background:var(--color-secondary);color:#fff; }
:global(.dark) .btn-outline { color:var(--brand);border-color:var(--brand); }
:global(.dark) .btn-outline:hover { background:var(--brand);color:var(--color-secondary); }
.btn-sm { padding:.45rem 1rem;font-size:.8rem; }
.btn-xs { padding:.35rem .75rem;font-size:.75rem; }
.section { padding:5rem 0; }
.section-alt { background:var(--bg-alt); }
.container { max-width:1150px;margin:0 auto;padding:0 1.5rem; }
.eyebrow { font-size:.7rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;font-family:'Poppins',sans-serif;color:var(--brand);display:block;margin-bottom:.75rem; }
.section-title { font-size:2rem;font-weight:800;color:var(--text-strong);letter-spacing:-.5px;margin-bottom:.625rem; }
.section-sub { font-size:.95rem;color:var(--text);line-height:1.7; }
.teal-line { width:48px;height:3px;background:var(--brand);border-radius:3px;margin-bottom:1.25rem; }
.hero { min-height:100vh;display:flex;align-items:center;position:relative;overflow:hidden;padding-top:64px; }
.hero-bg { position:absolute;inset:0;pointer-events:none;overflow:hidden; }
.hero-ring { position:absolute;border-radius:50%;border:1px solid rgba(0,212,178,.1); }
.hero-orb { position:absolute;border-radius:50%;background:radial-gradient(circle,rgba(0,212,178,.06) 0%,transparent 70%); }
.hero-content { position:relative;z-index:1;max-width:1150px;margin:0 auto;padding:0 1.5rem;width:100%; }
.cf-card { background:var(--bg-alt);border:1px solid var(--border);border-radius:1rem; }
.staff-card { background:var(--bg-alt);border:1px solid var(--border);border-radius:1.25rem;overflow:hidden;transition:all .3s; }
.staff-card:hover { transform:translateY(-4px);box-shadow:0 20px 40px rgba(0,0,0,.08);border-color:var(--brand); }
.staff-avatar { width:100%;height:140px;display:flex;align-items:center;justify-content:center;font-size:3.5rem;font-weight:800;font-family:'Poppins',sans-serif; }
/* Small round avatar for the hero's "Meet Our Experts" preview list — same colour convention as
   .staff-avatar (per-expert accent color falling back to the clinic's brand color), just sized
   for an inline row instead of a full staff card. */
.expert-avatar-sm { width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:800;font-family:'Poppins',sans-serif;flex-shrink:0; }
.service-card { background:var(--bg);border:1px solid var(--border);border-radius:1rem;padding:1.5rem;transition:all .3s; }
.service-card:hover { border-color:var(--brand);box-shadow:0 12px 30px rgba(0,212,178,.08); }
.hours-table { width:100%;border-collapse:collapse; }
.hours-table tr { border-bottom:1px solid var(--border); }
.hours-table tr:last-child { border-bottom:none; }
.hours-table td { padding:.625rem .25rem;font-size:.85rem; }
.appt-input { width:100%;padding:.625rem .875rem;border-radius:.5rem;border:1.5px solid var(--border);background:var(--bg);color:var(--text-strong);font-size:.88rem;outline:none;font-family:'Inter',sans-serif;transition:border .15s,box-shadow .15s; }
.appt-input:focus { border-color:var(--brand);box-shadow:0 0 0 3px rgba(0,212,178,.12); }
.appt-label { font-size:.8rem;font-weight:600;color:var(--text-strong);margin-bottom:.3rem;display:block;font-family:'Poppins',sans-serif; }
.badge { display:inline-block;padding:.2rem .625rem;border-radius:99px;font-size:.7rem;font-weight:700;font-family:'Poppins',sans-serif; }
.badge-brand { background:rgba(0,212,178,.12);color:var(--brand);border:1px solid rgba(0,212,178,.25); }
.badge-navy { background:rgba(10,37,64,.08);color:var(--color-secondary);border:1px solid rgba(10,37,64,.15); }
:global(.dark) .badge-navy { background:rgba(255,255,255,.08);color:var(--text-strong);border-color:var(--border); }
.cf-toast { position:fixed;bottom:1.5rem;right:1.5rem;z-index:99;padding:.75rem 1.5rem;border-radius:.75rem;background:var(--color-secondary);color:#fff;font-family:'Poppins',sans-serif;font-weight:600;font-size:.875rem;box-shadow:0 8px 24px rgba(0,0,0,.2);display:flex;align-items:center;gap:.5rem; }
:global(.dark) .cf-toast { background:var(--brand);color:var(--color-secondary); }
/* ─── Profile dropdown (matches Index.vue's own user-menu-anchor pattern) ─── */
.icon-btn-round { width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);background:var(--bg-alt);color:var(--text);cursor:pointer;font-size:.85rem;flex-shrink:0; }
.user-menu { position:absolute;right:0;top:calc(100% + .5rem);width:200px;background:var(--bg);border:1px solid var(--border);border-radius:.75rem;box-shadow:0 12px 30px rgba(0,0,0,.15);overflow:hidden;z-index:60; }
.user-menu-header { padding:.7rem 1rem;border-bottom:1px solid var(--border); }
.user-menu-item { display:flex;align-items:center;gap:.6rem;width:100%;text-align:left;padding:.6rem 1rem;font-size:.8rem;font-weight:600;color:var(--text-strong);background:none;border:none;cursor:pointer;text-decoration:none;font-family:'Inter',sans-serif; }
.user-menu-item:hover { background:var(--bg-alt); }
/* Minimal footer for the ops views (Front Desk/Consultation/Checkout) — one thin strip, not
   the full multi-row public-page footer, since vertical space is scarce on these dense screens. */
.ops-footer { flex-shrink:0;padding:.6rem 1.5rem;border-top:1px solid var(--cf-border);display:flex;align-items:center;justify-content:space-between;gap:1rem;font-size:.7rem;color:var(--cf-text);flex-wrap:wrap; }
.ops-footer a { color:var(--color-primary);font-weight:600; }
.modal-bg { position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(5px);z-index:60;display:flex;align-items:center;justify-content:center;padding:1rem; }
.modal-panel { background:var(--bg);border:1px solid var(--border);border-radius:1.25rem;padding:2rem;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;box-shadow:0 30px 60px rgba(0,0,0,.3); }
.grad-text { background:linear-gradient(135deg,#00D4B2 0%,#0A7A6E 50%,#00D4B2 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text; }
.section-header { text-align:center;margin-bottom:3rem; }
/* Live Now — 2 switchable tabs (Active Sessions / Upcoming Appointments), each rendering the
   same horizontally-scrollable card row below the hero. */
.live-now-tabs { display:inline-flex;gap:.4rem;background:var(--bg);border:1px solid var(--border);border-radius:.75rem;padding:.3rem;margin-top:1.25rem; }
.live-now-tabs button { display:flex;align-items:center;gap:.5rem;font-family:'Poppins',sans-serif;font-weight:700;font-size:.8rem;color:var(--text);background:transparent;border:none;border-radius:.5rem;padding:.5rem 1rem;cursor:pointer;transition:all .15s; }
.live-now-tabs button.active { background:var(--brand);color:#fff; }
.live-now-tabs button.active .badge-brand { background:rgba(255,255,255,.25);color:#fff;border-color:transparent; }
.sessions-scroll { display:flex;gap:1.125rem;overflow-x:auto;padding-bottom:.5rem;scroll-snap-type:x proximity; }
.session-card { flex:0 0 220px;scroll-snap-align:start;background:var(--bg);border:1px solid var(--border);border-radius:1rem;padding:1.25rem;cursor:pointer;transition:all .2s; }
.session-card:hover { transform:translateY(-3px);box-shadow:0 12px 30px rgba(0,212,178,.12);border-color:var(--brand); }
@media (max-width:768px) {
  .nav-links { display:none }
  .hero-grid,.two-col-grid { grid-template-columns:1fr!important }
  .staff-grid,.services-grid { grid-template-columns:1fr 1fr!important }
}
@media (max-width:480px) {
  .staff-grid,.services-grid { grid-template-columns:1fr!important }
}
</style>
