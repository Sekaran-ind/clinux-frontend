// SPEC-22 (docs/SPEC-22-PERSISTED-WORKFLOW-SYSTEM-FLOWS-CUBO-STATE-MIRROR-DRAWER-CAPTURE.md) §5.1's
// 3-pane shell split this out of Cubo.vue — the nav strip (Cubo.vue) and the content pane (whichever
// page hosts the guided-setup shell, e.g. Index.vue) both need the same component/label maps, and
// neither is an ancestor of the other. Previously Cubo.vue-local (SPEC-20 §6), moved here rather than
// duplicated once a second consumer showed up, matching this codebase's own stated "revisit if a
// second one shows up" note on the original.
import RegisterForm from './RegisterForm.vue';
import LoginForm from './LoginForm.vue';
import ForgotPasswordForm from './ForgotPasswordForm.vue';
import ChangePasswordForm from './ChangePasswordForm.vue';
import SecurityQuestionForm from './SecurityQuestionForm.vue';

export const ENTRY_FORM_COMPONENTS = {
  register: RegisterForm,
  login: LoginForm,
  forgot_password: ForgotPasswordForm,
  change_password: ChangePasswordForm,
  security_question: SecurityQuestionForm,
};

export const ENTRY_MENU_OPTIONS = [
  { id: 'register', label: 'Register', icon: 'fa-user-plus' },
  { id: 'login', label: 'Log In', icon: 'fa-right-to-bracket' },
  { id: 'forgot_password', label: 'Forgot Password', icon: 'fa-key' },
  { id: 'change_password', label: 'Change Password', icon: 'fa-lock' },
];

export const ENTRY_INTROS = {
  register: "Let's get you set up. Fill in your details below.",
  login: 'Welcome back — log in with your email and password.',
  forgot_password: "No problem — let's get you back in.",
  change_password: 'Update your password below.',
  security_question: 'Want to set a recovery question in case you forget your password?',
};
