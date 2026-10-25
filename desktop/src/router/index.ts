import { createRouter, createWebHashHistory } from "vue-router";
import TitleScreen from "@/views/TitleScreen.vue";
import AdminPanel from "@/views/AdminPanel/index.vue";
import { useAuthStore } from "@/stores/auth";
import { usePhotoboothStore } from "@/stores/photobooth";
import { usePaymentStore } from "@/stores/payment";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      name: "title",
      component: TitleScreen,
    },
    {
      path: "/templates",
      name: "templates",
      component: () => import("@/views/TemplateSelect.vue"),
    },
    {
      path: "/bill-acceptor",
      name: "bill-acceptor",
      component: () => import("@/views/BillAcceptorView.vue"),
    },
    {
      path: "/camera",
      name: "camera",
      component: () => import("@/views/CameraView.vue"),
      meta: { requiresPayment: true },
    },
    {
      path: "/printing",
      name: "printing",
      component: () => import("@/views/PrintingView.vue"),
    },
    {
      path: "/qr",
      name: "qr",
      component: () => import("@/views/QRScanView.vue"),
    },
    {
      path: "/reprint",
      name: "reprint",
      component: () => import("@/views/ReprintView.vue"),
    },
    {
      path: "/gallery",
      name: "gallery",
      component: () => import("@/views/AdminPanel/GalleryView.vue"),
      // Auth removed — booth runs on-prem on operator-controlled
      // hardware; the kiosk doesn't gate access. Re-add
      // `meta: { requiresAuth: true }` here if you bring login back.
    },
    {
      // Login route kept available but no longer reached from the UI.
      // Useful if auth is re-enabled later (just point the badge tap
      // back at "/login" in TitleScreen.vue and the guard below will
      // do the rest).
      path: "/login",
      name: "login",
      component: () => import("@/views/LoginView.vue"),
    },
    {
      path: "/admin",
      name: "admin",
      component: AdminPanel,
      // Auth removed — see note on /gallery above.
    },
  ],
});

// Auth guard (inert unless a route sets meta.requiresAuth) + payment
// gate so /camera cannot be reached while Payment mode is ON without
// a consumed sale / free-booth grant.
router.beforeEach((to, _from, next) => {
  const authStore = useAuthStore();
  if (to.meta.requiresAuth && !authStore.checkAuth()) {
    next({ name: "login", query: { redirect: to.fullPath } });
    return;
  }
  if (to.meta.requiresPayment) {
    const booth = usePhotoboothStore();
    const payment = usePaymentStore();
    if (booth.paymentEnabled && !payment.paidForSession) {
      next(
        booth.selectedTemplate
          ? { name: "bill-acceptor" }
          : { name: "templates" },
      );
      return;
    }
  }
  next();
});

export default router;
