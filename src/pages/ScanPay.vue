<script setup>
// Scan & Pay (/registries/scan-pay; NHA Scan & Pay doc v1.0). A patient scans the counter QR with
// the ABHA app and chooses Pay; ABDM sends their profile to the gateway, which offers the bills
// published for them at Checkout (or waits here for staff to add one). They pick items, get a pay
// page (UPI to the facility's UPI id), and staff confirm the money arrived — ABDM tells their app.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { listBills, listOrders, billOrder, recordPayment } from '../data/hie.js';

const orders = ref([]);
const bills = ref([]);
const error = ref('');
const notice = ref('');
async function load() {
  try {
    const [o, b] = await Promise.all([listOrders(), listBills()]);
    orders.value = o.orders || [];
    bills.value = b.bills || [];
    error.value = '';
  } catch (err) { error.value = err.message; }
}
let timer = null;
onMounted(() => { load(); timer = setInterval(load, 5000); });
onBeforeUnmount(() => clearInterval(timer));

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (d) => (d ? new Date(String(d).includes('T') ? d : `${d.replace(' ', 'T')}Z`).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const items = (procedures) => (procedures || []).flatMap((p) => p.services.map((s) => `${s.name} ${rupees(s.amount)}`)).join(', ');
const STATE = {
  awaiting_bill: ['No bill yet — add one', 'badge-amber'],
  bill_sent: ['Bill in their ABHA app', 'badge-navy'],
  payment_requested: ['Paying', 'badge-amber'],
  closed: ['Closed', 'badge-muted'],
};
const PAY = { SUCCESS: ['Paid', 'badge-teal'], FAIL: ['Payment failed', 'badge-red'], CANCELED: ['Cancelled', 'badge-muted'], REFUND_INITIATED: ['Refund started', 'badge-amber'], REFUND_SUCCESS: ['Refunded', 'badge-muted'] };
const badge = (o) => (o.paymentStatus && o.paymentStatus !== 'PENDING' ? PAY[o.paymentStatus] : STATE[o.status]) || [o.status, 'badge-muted'];
const waiting = computed(() => orders.value.filter((o) => o.status === 'awaiting_bill' || o.status === 'payment_requested').length);

// A bill typed at the counter for an order that came in before Checkout published one.
const billFor = ref(null);
const line = ref({ category: 'OPD consultation', name: '', amount: '' });
async function sendBill() {
  try {
    await billOrder(billFor.value.id, [{ category: line.value.category, services: [{ name: line.value.name, amount: Number(line.value.amount) }] }]);
    billFor.value = null;
    line.value = { category: 'OPD consultation', name: '', amount: '' };
    await load();
  } catch (err) { error.value = err.message; }
}

const busy = ref('');
async function pay(o, status, method) {
  if (status !== 'SUCCESS' && !window.confirm(`Mark ${o.name || o.abhaAddress}’s payment as ${PAY[status][0].toLowerCase()}? ABDM tells their ABHA app.`)) return;
  busy.value = o.id;
  try {
    const res = await recordPayment(o.id, { status, method });
    notice.value = res.warning || '';
    await load();
  } catch (err) { error.value = err.message; } finally { busy.value = ''; }
}
</script>

<template>
  <div class="page page-wide">
    <nav class="page-crumbs"><RouterLink to="/registries">Registries</RouterLink><i class="fas fa-chevron-right" style="font-size:.55rem"></i><span>Scan &amp; Pay</span></nav>
    <div class="page-header">
      <div>
        <h1 class="page-title">Scan &amp; Pay <span v-if="waiting" class="badge badge-amber">{{ waiting }} open</span></h1>
        <p class="page-subtitle">Patients scan the counter QR with the ABHA app and pay their bill there. Bills sent from Checkout appear in their app; confirm each payment once it reaches your account. Turn Scan &amp; Pay on per facility in <RouterLink to="/registries/abdm?tab=settings">ABDM records → Settings</RouterLink>.</p>
      </div>
    </div>
    <p v-if="error" class="ui-banner" style="border-color:#fecaca;background:#fef2f2;color:#b91c1c"><i class="fas fa-circle-exclamation"></i> {{ error }}</p>
    <p v-if="notice" class="ui-banner"><i class="fas fa-circle-info"></i> {{ notice }}</p>

    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">Orders</div><div class="panel-sub">From the last 7 days. Refreshes every few seconds.</div></div></div>
      <div v-if="!orders.length" class="empty-state" style="padding:2rem 1rem">
        <div class="empty-state-icon"><i class="fas fa-indian-rupee-sign"></i></div>
        <div class="empty-state-title">No Scan &amp; Pay orders yet</div>
        <p class="empty-state-text">When a patient scans the counter QR and chooses Pay, their order appears here.</p>
      </div>
      <div v-else class="table-wrap">
        <table class="q-table" data-testid="scan-pay-orders">
          <thead><tr><th>Patient</th><th>Bill</th><th>Status</th><th></th></tr></thead>
          <tbody>
            <tr v-for="o in orders" :key="o.id">
              <td><div class="cell-strong">{{ o.name || '—' }}</div><div class="cell-code">{{ o.abhaAddress }}</div><div class="cell-muted">counter {{ o.counterId || '—' }} · {{ fmt(o.createdAt) }}</div></td>
              <td>
                <template v-if="o.selected"><div class="cell-strong">{{ rupees(o.amount) }}</div><div class="cell-muted">{{ items(o.selected) }}</div><div class="cell-muted">Order {{ o.orderNumber }}</div></template>
                <div v-else-if="o.offered" class="cell-muted">Offered: {{ items(o.offered) }}</div>
                <span v-else class="cell-muted">—</span>
              </td>
              <td>
                <span class="badge" :class="badge(o)[1]">{{ badge(o)[0] }}</span>
                <div v-if="o.paymentMethod" class="cell-muted">{{ o.paymentMethod }} · {{ fmt(o.paymentDate) }}</div>
                <div v-if="o.paymentStatus && o.paymentStatus !== 'PENDING' && !o.notifyAcknowledged" class="cell-muted">ABDM not yet confirmed</div>
                <div v-if="o.error" class="cell-muted err-text">{{ o.error }}</div>
              </td>
              <td class="actions">
                <button v-if="o.status === 'awaiting_bill'" class="ui-btn ui-btn-primary" @click="billFor = o"><i class="fas fa-plus"></i> Add bill</button>
                <template v-else-if="o.paymentStatus === 'PENDING'">
                  <button class="ui-btn ui-btn-primary" :disabled="busy === o.id" data-testid="pay-received" @click="pay(o, 'SUCCESS', 'UPI')"><i class="fas fa-check"></i> UPI received</button>
                  <button class="ui-btn" :disabled="busy === o.id" @click="pay(o, 'SUCCESS', 'Cash')">Cash</button>
                  <button class="ui-btn" :disabled="busy === o.id" title="Payment failed" @click="pay(o, 'FAIL')"><i class="fas fa-xmark"></i></button>
                </template>
                <button v-else-if="o.paymentStatus === 'SUCCESS'" class="ui-btn" :disabled="busy === o.id" @click="pay(o, 'REFUND_INITIATED')">Refund</button>
                <button v-else-if="o.paymentStatus === 'REFUND_INITIATED'" class="ui-btn" :disabled="busy === o.id" @click="pay(o, 'REFUND_SUCCESS')">Refund done</button>
                <a v-if="o.payUrl" :href="o.paymentStatus === 'SUCCESS' ? `${o.payUrl}/receipt` : o.payUrl" target="_blank" rel="noopener" class="ui-link" style="margin-left:.4rem">{{ o.paymentStatus === 'SUCCESS' ? 'receipt' : 'pay page' }}</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <form v-if="billFor" class="panel bill-form" @submit.prevent="sendBill">
      <div class="panel-title">Bill for {{ billFor.name || billFor.abhaAddress }}</div>
      <select v-model="line.category" class="cf-input"><option>OPD consultation</option><option>Laboratory and Diagnostics</option><option>Pharmacy</option><option>Miscellaneous/Other</option></select>
      <input v-model="line.name" class="cf-input" placeholder="Item, e.g. Consultation" required />
      <input v-model="line.amount" class="cf-input" type="number" min="1" step="0.01" placeholder="Amount (₹)" required />
      <button class="ui-btn ui-btn-primary" type="submit"><i class="fas fa-paper-plane"></i> Send to their ABHA app</button>
      <button class="ui-btn" type="button" @click="billFor = null">Cancel</button>
    </form>

    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">Bills waiting for a scan</div><div class="panel-sub">Sent from Checkout; the patient sees them when they scan the counter QR and choose Pay.</div></div></div>
      <div v-if="!bills.length" class="empty-state" style="padding:1.5rem"><p class="empty-state-text">None.</p></div>
      <table v-else class="q-table">
        <tbody><tr v-for="b in bills" :key="b.id"><td><div class="cell-strong">{{ b.name || '—' }}</div><div class="cell-code">{{ b.abhaAddress }}</div></td><td>{{ rupees(b.amount) }}<div class="cell-muted">{{ items(b.procedures) }}</div></td><td class="cell-muted">{{ b.status === 'offered' ? 'in their app' : 'waiting' }} · {{ fmt(b.createdAt) }}</td></tr></tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: .75rem; padding: .9rem 1rem; border-bottom: 1px solid var(--shell-border); }
.panel + .panel, .panel + form, form + .panel { margin-top: 1.25rem; }
.panel-title { font-weight: 700; font-size: .9rem; color: var(--shell-text-strong); }
.panel-sub { font-size: .75rem; color: var(--shell-text-muted); margin-top: .15rem; }
.table-wrap { overflow-x: auto; }
.q-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
.q-table th { text-align: left; font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; color: var(--shell-text-muted); padding: .55rem 1rem; border-bottom: 1px solid var(--shell-border); }
.q-table td { padding: .6rem 1rem; border-bottom: 1px solid var(--shell-border); vertical-align: top; }
.cell-strong { font-weight: 600; color: var(--shell-text-strong); }
.cell-muted { color: var(--shell-text-muted); font-size: .74rem; }
.cell-code { font-family: ui-monospace, monospace; font-size: .76rem; }
.err-text { color: #b91c1c; }
.actions { text-align: right; white-space: nowrap; }
.actions .ui-btn { padding: .3rem .6rem; margin-left: .25rem; }
.bill-form { padding: 1rem; display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.bill-form .panel-title { width: 100%; }
.bill-form .cf-input { max-width: 14rem; }
@media (max-width: 640px) { .q-table th, .q-table td { padding: .5rem .6rem; } .actions { white-space: normal; } }
</style>
