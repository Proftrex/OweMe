const SUPABASE_URL = "https://khrawdzhvfdfrvbhbhge.supabase.co";

const SUPABASE_KEY = "sb_publishable_diLxiZhI5gM-L_WrCh2Hfg_er9qLNtB";

const OWEME_VAPID_PUBLIC_KEY = "BPV5jBjAAtJWmhGRJ4ml6A5BE3zJvAd4hhDKEE0rttx21dmY63R0Id3Wo7JK766sinpJPVCNBQRsTkscsODwJmQ";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);

console.log("Supabase connected:", !!supabaseClient);

const state = {
  user: null,
  groups: [],
  invitations: [],
  groupsLoadedAt: 0,
  currentGroup: null,
  currentPage: "home"
};

const $ = (selector) => document.querySelector(selector);


document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();

  const {
    data: { session }
  } = await supabaseClient.auth.getSession();

  const hashParams =
    new URLSearchParams(
      window.location.hash.replace(/^#/, "")
    );

  const recoveryType =
    hashParams.get("type");

  const urlParams =
    new URLSearchParams(
      window.location.search
    );

  const sharedGroupId =
    urlParams.get("group");

  if (sharedGroupId) {
    console.log(
      "OWEME SHARED GROUP LINK:",
      sharedGroupId
    );
  }

  if (
    recoveryType === "recovery" &&
    session
  ) {
    showAuth();
    showResetPasswordPanel();
    return;
  }

  if (!session) {
    showAuth();
    return;
  }

  setLoading(true, "Loading, please wait...");

  try {
    const {
      data: profile,
      error: profileError
    } = await supabaseClient
      .from("profiles")
      .select("*")
      .eq("id", session.user.id)
      .single();

    if (profileError) {
      throw new Error(
        "Your account is signed in, but your OweMe profile could not be loaded."
      );
    }

    state.user = {
      userId: profile.id,
      username: profile.username,
      email: session.user.email,
      displayName: profile.display_name,
      status: profile.status,
      createdAt: profile.created_at
    };

    if (window.Capacitor?.isNativePlatform()) {
      await initializePushNotifications();
    } else {
      await initializeWebPushNotifications();
    }

    showApp();

    await loadNotificationCount();
    await loadHome(null, true);

    if (
      new URLSearchParams(window.location.search).get("pushdebug") === "1"
    ) {
      await runWebPushDiagnostics();
    }

    if (sharedGroupId) {
      await handleSharedGroupLink(sharedGroupId);
    }

  } catch (error) {

    console.error("SUPABASE SESSION RESTORE ERROR:", error);

    state.user = null;
    state.groups = [];
    state.currentGroup = null;

    showAuth();

    toast(
      error.message ||
      "Unable to load your account."
    );

  } finally {
    setLoading(false);
  }
}


/* =========================================================
   PUSH NOTIFICATIONS
   ========================================================= */


async function initializeWebPushNotifications() {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      console.warn("Web Push is not supported in this browser.");
      return;
    }

    if (!state.user?.userId) {
      return;
    }

    const registration = await navigator.serviceWorker.ready;

    let permission = Notification.permission;

    if (permission === "default") {
      permission = await Notification.requestPermission();
    }

    if (permission !== "granted") {
      console.warn("Web notification permission was not granted.");
      return;
    }

    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          OWEME_VAPID_PUBLIC_KEY
        )
      });
    }

    const subscriptionJson = subscription.toJSON();

    const { error } = await supabaseClient
      .from("push_tokens")
      .upsert(
        {
          user_id: state.user.userId,
          token: JSON.stringify(subscriptionJson),
          platform: "web",
          updated_at: new Date().toISOString()
        },
        { onConflict: "user_id,token" }
      );

    if (error) {
      console.error("SAVE WEB PUSH SUBSCRIPTION ERROR:", error);
    } else {
      console.log("OWEME WEB PUSH SUBSCRIPTION SAVED");
    }

  } catch (error) {
    console.error("OWEME WEB PUSH INITIALIZATION ERROR:", error);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const rawData = window.atob(base64);

  return Uint8Array.from(
    [...rawData].map(char => char.charCodeAt(0))
  );
}

async function initializePushNotifications() {
  const pushLog = (message, data = null) => {
    const entry = {
      time: new Date().toISOString(),
      message,
      data
    };

    console.log("OWEME PUSH:", message, data || "");

    try {
      const logs = JSON.parse(
        localStorage.getItem("oweme_push_debug") || "[]"
      );

      logs.push(entry);

      if (logs.length > 50) {
        logs.splice(0, logs.length - 50);
      }

      localStorage.setItem(
        "oweme_push_debug",
        JSON.stringify(logs)
      );
    } catch (error) {
      console.error("OWEME PUSH DEBUG LOG ERROR:", error);
    }
  };

  try {
    pushLog("initializePushNotifications started");

    if (!window.Capacitor) {
      pushLog("Capacitor is not available");
      return;
    }

    if (!window.Capacitor.isNativePlatform()) {
      pushLog("Not running on native platform");
      return;
    }

    pushLog("Native platform detected");

    if (
      !window.Capacitor.Plugins ||
      !window.Capacitor.Plugins.PushNotifications
    ) {
      pushLog("Push Notifications plugin is not available");
      return;
    }

    const { PushNotifications } =
      window.Capacitor.Plugins;

    pushLog("Push Notifications plugin available");

    let permission =
      await PushNotifications.checkPermissions();

    pushLog(
      "Permission checked",
      permission
    );

    if (permission.receive === "prompt") {
      pushLog("Requesting notification permission");

      permission =
        await PushNotifications.requestPermissions();

      pushLog(
        "Permission request completed",
        permission
      );
    }

    if (permission.receive !== "granted") {
      pushLog(
        "Notification permission NOT granted",
        permission
      );
      return;
    }

    pushLog("Notification permission granted");

    PushNotifications.addListener(
      "registration",
      async (token) => {
        pushLog(
          "FCM REGISTRATION EVENT RECEIVED",
          {
            tokenLength: token?.value
              ? token.value.length
              : 0
          }
        );

        console.log(
          "OWEME FCM TOKEN:",
          token?.value
        );

        if (!token?.value) {
          pushLog("FCM token is empty");
          return;
        }

        const userId =
          state.user?.userId;

        pushLog(
          "Checking logged-in user",
          {
            hasUser: !!userId,
            userId: userId || null
          }
        );

        if (!userId) {
          pushLog(
            "FCM token received but user is not ready"
          );
          return;
        }

        pushLog(
          "Saving FCM token to Supabase"
        );

        const { error } =
          await supabaseClient
            .from("push_tokens")
            .upsert(
              {
                user_id: userId,
                token: token.value,
                platform: "android",
                updated_at:
                  new Date().toISOString()
              },
              {
                onConflict:
                  "user_id,token"
              }
            );

        if (error) {
          pushLog(
            "SUPABASE PUSH TOKEN SAVE ERROR",
            {
              message: error.message,
              code: error.code,
              details: error.details,
              hint: error.hint
            }
          );

          console.error(
            "SAVE PUSH TOKEN ERROR:",
            error
          );
        } else {
          pushLog(
            "FCM TOKEN SAVED TO SUPABASE"
          );

          console.log(
            "OWEME PUSH TOKEN SAVED"
          );
        }
      }
    );

    PushNotifications.addListener(
      "registrationError",
      (error) => {
        pushLog(
          "FCM REGISTRATION ERROR",
          error
        );

        console.error(
          "OWEME PUSH REGISTRATION ERROR:",
          error
        );
      }
    );

    PushNotifications.addListener(
      "pushNotificationReceived",
      (notification) => {
        pushLog(
          "PUSH NOTIFICATION RECEIVED",
          notification
        );

        console.log(
          "OWEME PUSH NOTIFICATION RECEIVED:",
          notification
        );
      }
    );

    PushNotifications.addListener(
      "pushNotificationActionPerformed",
      (action) => {
        pushLog(
          "PUSH NOTIFICATION ACTION",
          action
        );

        console.log(
          "OWEME PUSH NOTIFICATION ACTION:",
          action
        );
      }
    );

    pushLog(
      "Calling PushNotifications.register()"
    );

    await PushNotifications.register();

    pushLog(
      "PushNotifications.register() completed"
    );
  } catch (error) {
    pushLog(
      "initializePushNotifications FAILED",
      {
        message: error?.message,
        name: error?.name,
        stack: error?.stack
      }
    );

    console.error(
      "OWEME PUSH INITIALIZATION ERROR:",
      error
    );
  }
}

async function getBalancesFromSupabase(groupId) {
  const { data: members, error: memberError } =
    await supabaseClient
      .from("group_members")
      .select("user_id, role, status")
      .eq("group_id", groupId)
      .eq("status", "ACTIVE");

  if (memberError) throw memberError;

  const { data: expenses, error: expenseError } =
    await supabaseClient
      .from("expenses")
      .select(`
        id,
        paid_by_user_id,
        created_by,
        amount,
        expense_participants (
          user_id,
          share_amount
        )
      `)
      .eq("group_id", groupId)
      .eq("status", "ACTIVE");

  if (expenseError) throw expenseError;

  const { data: payments, error: paymentError } =
    await supabaseClient
      .from("payment_submissions")
      .select(`
        payer_user_id,
        recipient_user_id,
        amount_paid,
        status
      `)
      .eq("group_id", groupId)
      .eq("status", "CONFIRMED");

  if (paymentError) throw paymentError;

  const balances = {};

  (members || []).forEach(member => {
    balances[member.user_id] = {
      userId: member.user_id,
      totalPaid: 0,
      totalShare: 0,
      balance: 0
    };
  });

  (expenses || []).forEach(expense => {
    const payer = balances[expense.paid_by_user_id];

    if (payer) {
      payer.totalPaid += Number(expense.amount || 0);
    }

    (expense.expense_participants || []).forEach(participant => {
      const member = balances[participant.user_id];

      if (member) {
        member.totalShare += Number(
          participant.share_amount || 0
        );
      }
    });
  });

  Object.values(balances).forEach(item => {
    item.balance =
      Math.round(
        (item.totalPaid - item.totalShare) * 100
      ) / 100;
  });

  /* Apply confirmed settlement payments */
  (payments || []).forEach(payment => {
    const amountPaid =
      Number(payment.amount_paid || 0);

    if (amountPaid <= 0) return;

    if (balances[payment.payer_user_id]) {
      balances[payment.payer_user_id].balance +=
        amountPaid;
    }

    if (balances[payment.recipient_user_id]) {
      balances[payment.recipient_user_id].balance -=
        amountPaid;
    }
  });

  Object.values(balances).forEach(item => {
    item.balance =
      Math.round(item.balance * 100) / 100;
  });

  return {
    success: true,
    data: {
      balances: Object.values(balances)
    }
  };
}


async function getSettlementsFromSupabase(groupId) {

  const { data: expenses, error: expenseError } =
    await supabaseClient
      .from("expenses")
      .select(`
        id,
        paid_by_user_id,
        amount,
        expense_participants (
          user_id,
          share_amount
        )
      `)
      .eq("group_id", groupId)
      .eq("status", "ACTIVE");

  if (expenseError) {
    throw expenseError;
  }

  const membersResult =
    await supabaseClient.rpc(
      "get_group_members",
      {
        lookup_group_id: groupId
      }
    );

  if (membersResult.error) {
    throw new Error(
      membersResult.error.message ||
      "Unable to load group members."
    );
  }

  const members =
    membersResult.data || [];

  const memberMap = {};

  members.forEach(member => {

    memberMap[String(member.user_id)] = {
      username:
        member.username || "",

      displayName:
        member.display_name || ""
    };

  });

  /*
   * Build direct obligations from each expense.
   *
   * If Alice pays an expense and Bob has a ₱500 share,
   * Bob owes Alice ₱500.
   *
   * This intentionally does NOT net unrelated expenses
   * across the entire group.
   */

  const obligations = {};

  (expenses || []).forEach(expense => {

    const payerId =
      String(expense.paid_by_user_id);

    (expense.expense_participants || []).forEach(participant => {

      const participantId =
        String(participant.user_id);

      const shareAmount =
        Number(participant.share_amount || 0);

      if (
        participantId === payerId ||
        shareAmount <= 0
      ) {
        return;
      }

      const key =
        `${participantId}|${payerId}`;

      if (!obligations[key]) {
        obligations[key] = {
          fromUserId: participantId,
          toUserId: payerId,
          amount: 0
        };
      }

      obligations[key].amount =
        Math.round(
          (
            obligations[key].amount +
            shareAmount
          ) * 100
        ) / 100;

    });

  });

  const settlements = [];

  for (const obligation of Object.values(obligations)) {

    const amount =
      Math.round(
        Number(obligation.amount || 0) * 100
      ) / 100;

    if (amount <= 0) {
      continue;
    }

    const {
      data: settlementId,
      error: settlementError
    } = await supabaseClient.rpc(
      "ensure_settlement",
      {
        p_group_id: groupId,
        p_from_user_id: obligation.fromUserId,
        p_to_user_id: obligation.toUserId,
        p_amount: amount
      }
    );

    if (settlementError) {
      console.error(
        "ENSURE SETTLEMENT ERROR:",
        settlementError
      );

      throw new Error(
        settlementError.message ||
        "Unable to create settlement."
      );
    }

    settlements.push({

      settlementId,

      groupId,

      fromUserId:
        obligation.fromUserId,

      fromUsername:
        memberMap[
          String(obligation.fromUserId)
        ]?.username || "",

      fromDisplayName:
        memberMap[
          String(obligation.fromUserId)
        ]?.displayName || "",

      toUserId:
        obligation.toUserId,

      toUsername:
        memberMap[
          String(obligation.toUserId)
        ]?.username || "",

      toDisplayName:
        memberMap[
          String(obligation.toUserId)
        ]?.displayName || "",

      amount,

      status:
        "UNPAID"

    });

  }

  /*
   * Reduce each settlement by payments that have already been
   * submitted or confirmed.
   *
   * The settlement amount is the original obligation.
   * Payables should show only the current outstanding balance.
   */
  const settlementIds =
    settlements
      .map(settlement => settlement.settlementId)
      .filter(Boolean);

  if (settlementIds.length) {

    const {
      data: paymentSubmissions,
      error: paymentError
    } = await supabaseClient
      .from("payment_submissions")
      .select(`
        settlement_id,
        amount_paid,
        status
      `)
      .eq("group_id", groupId)
      .in("settlement_id", settlementIds)
      .in("status", ["SUBMITTED", "CONFIRMED"]);

    if (paymentError) {
      throw paymentError;
    }

    const paidBySettlement = {};

    (paymentSubmissions || []).forEach(payment => {

      const id =
        String(payment.settlement_id);

      if (!paidBySettlement[id]) {
        paidBySettlement[id] = 0;
      }

      paidBySettlement[id] +=
        Number(payment.amount_paid || 0);

    });

    settlements.forEach(settlement => {

      const originalAmount =
        Number(settlement.amount || 0);

      const paidAmount =
        Number(
          paidBySettlement[
            String(settlement.settlementId)
          ] || 0
        );

      settlement.amount =
        Math.max(
          0,
          Math.round(
            (originalAmount - paidAmount) * 100
          ) / 100
        );

      settlement.status =
        settlement.amount <= 0
          ? "PAID"
          : "UNPAID";

    });

  }

  /*
   * Net reciprocal obligations between the same two users.
   *
   * Example:
   *   A owes B ₱297
   *   B owes A ₱45.50
   *
   * Display:
   *   A owes B ₱251.50
   *
   * This only changes the settlement view.
   * Expense records and original settlement records remain unchanged.
   */
  const settlementPairs = {};

  settlements.forEach(settlement => {
    const fromUserId = String(settlement.fromUserId);
    const toUserId = String(settlement.toUserId);

    const pairKey =
      [fromUserId, toUserId].sort().join("|");

    if (!settlementPairs[pairKey]) {
      settlementPairs[pairKey] = [];
    }

    settlementPairs[pairKey].push(settlement);
  });

  const outstandingSettlements = [];

  Object.values(settlementPairs).forEach(pair => {
    if (pair.length === 1) {
      const settlement = pair[0];

      if (Number(settlement.amount || 0) > 0) {
        outstandingSettlements.push(settlement);
      }

      return;
    }

    const first = pair[0];
    const second = pair[1];

    const firstAmount =
      Number(first.amount || 0);

    const secondAmount =
      Number(second.amount || 0);

    if (firstAmount === secondAmount) {
      return;
    }

    const netAmount =
      Math.round(
        Math.abs(firstAmount - secondAmount) * 100
      ) / 100;

    const netSettlement =
      firstAmount > secondAmount
        ? first
        : second;

    netSettlement.amount = netAmount;
    netSettlement.status = "UNPAID";

    outstandingSettlements.push(
      netSettlement
    );
  });

  return {
    success: true,

    settlements: outstandingSettlements,

    data: {
      settlements: outstandingSettlements
    }
  };

}

async function getPendingPaymentsFromSupabase(groupId) {
  const { data, error } =
    await supabaseClient
      .from("payment_submissions")
      .select("*")
      .eq("group_id", groupId)
      .eq("status", "SUBMITTED")
      .eq(
        "recipient_user_id",
        state.user.userId
      )
      .order("submitted_at", {
        ascending: false
      });

  if (error) throw error;

  const payments =
    (data || []).map(payment => ({
      paymentSubmissionId: payment.id,
      settlementId: payment.settlement_id,
      groupId: payment.group_id,
      payerUserId: payment.payer_user_id,
      recipientUserId: payment.recipient_user_id,
      paymentOption: payment.payment_option,
      paymentDetailId: payment.payment_detail_id,
      amountDue: Number(payment.amount_due || 0),
      amountPaid: Number(payment.amount_paid || 0),
      proofFileUrl: payment.proof_file_url,
      notes: payment.notes,
      status: payment.status,
      submittedAt: payment.submitted_at
    }));

  return {
    success: true,
    payments,
    data: {
      payments
    }
  };
}


function bindEvents() {

  const loginForm = $("#loginForm");
  const registerForm = $("#registerForm");
  const showRegister = $("#showRegister");
  const showLogin = $("#showLogin");
  const forgotPasswordButton = $("#forgotPasswordButton");
  const backToLoginFromReset = $("#backToLoginFromReset");
  const resetPasswordForm = $("#resetPasswordForm");
  const refreshButton = $("#refreshButton");
  const closeModalButton = $("#closeModal");
  const modalBackdrop = $(".modal-backdrop");

  if (loginForm) {
    loginForm.addEventListener("submit", handleLogin);
  }

  if (registerForm) {
    registerForm.addEventListener("submit", handleRegister);
  }

  if (showRegister) {
    showRegister.addEventListener("click", function(event) {
      event.preventDefault();

      const loginPanel = $("#loginPanel");
      const registerPanel = $("#registerPanel");

      if (loginPanel) {
        loginPanel.classList.add("hidden");
      }

      if (registerPanel) {
        registerPanel.classList.remove("hidden");
      }
    });
  }

  if (showLogin) {
    showLogin.addEventListener("click", function(event) {
      event.preventDefault();

      const registerPanel = $("#registerPanel");
      const loginPanel = $("#loginPanel");

      if (registerPanel) {
        registerPanel.classList.add("hidden");
      }

      if (loginPanel) {
        loginPanel.classList.remove("hidden");
      }
    });
  }

  if (forgotPasswordButton) {
    forgotPasswordButton.addEventListener(
      "click",
      openForgotPassword
    );
  }

  if (backToLoginFromReset) {
    backToLoginFromReset.addEventListener(
      "click",
      showLoginPanel
    );
  }

  if (resetPasswordForm) {
    resetPasswordForm.addEventListener(
      "submit",
      handlePasswordReset
    );
  }

  document.querySelectorAll(".nav-item").forEach(function(button) {
    button.addEventListener("click", function() {
      navigate(button.dataset.page);
    });
  });

  if (refreshButton) {
    refreshButton.addEventListener("click", async function() {
      state.groupsLoadedAt = 0;

      if (state.currentGroup?.group?.groupId) {
        await refreshCurrentGroup();
        return;
      }

      await navigate(state.currentPage);
    });
  }

  if (closeModalButton) {
    closeModalButton.addEventListener("click", closeModal);
  }

  if (modalBackdrop) {
    modalBackdrop.addEventListener("click", closeModal);
  }

}

function showLoginPanel() {

  const loginPanel = $("#loginPanel");
  const registerPanel = $("#registerPanel");
  const resetPanel = $("#resetPasswordPanel");

  if (loginPanel) {
    loginPanel.classList.remove("hidden");
  }

  if (registerPanel) {
    registerPanel.classList.add("hidden");
  }

  if (resetPanel) {
    resetPanel.classList.add("hidden");
  }
}


function showResetPasswordPanel() {

  const loginPanel = $("#loginPanel");
  const registerPanel = $("#registerPanel");
  const resetPanel = $("#resetPasswordPanel");

  if (loginPanel) {
    loginPanel.classList.add("hidden");
  }

  if (registerPanel) {
    registerPanel.classList.add("hidden");
  }

  if (resetPanel) {
    resetPanel.classList.remove("hidden");
  }

}


async function openForgotPassword() {

  const identifier =
    $("#loginIdentifier")?.value.trim() || "";

  openModal(`

    <div class="modal-confirmation">

      <h2>Reset Password</h2>

      <p class="muted">
        Enter the email address linked to your OweMe account.
        We'll send you a password reset link.
      </p>

      <form id="forgotPasswordForm">

        <label>
          Email address

          <input
            id="forgotPasswordEmail"
            type="email"
            autocomplete="email"
            value="${
              identifier.includes("@")
                ? escapeHtml(identifier)
                : ""
            }"
            required
          >
        </label>

        <button
          type="submit"
          class="primary-button"
          style="margin-top:16px;"
        >
          Send Reset Link
        </button>

      </form>

    </div>

  `);

  $("#forgotPasswordForm").addEventListener(
    "submit",
    sendPasswordReset
  );
}


async function sendPasswordReset(event) {

  event.preventDefault();

  const email =
    $("#forgotPasswordEmail").value.trim();

  if (!email) {
    toast("Please enter your email address.");
    return;
  }

  try {

    setLoading(
      true,
      "Sending password reset link..."
    );

    const {
      error
    } = await supabaseClient.auth.resetPasswordForEmail(
      email,
      {
        redirectTo:
  "https://arkhonstudio.com/oweme_app/"
      }
    );

    if (error) {
      throw error;
    }

    closeModal();

    toast(
      "Password reset link sent. Check your email."
    );

  } catch (error) {

    console.error(
      "PASSWORD RESET REQUEST ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to send password reset link."
    );

  } finally {

    setLoading(false);

  }
}


async function handlePasswordReset(event) {

  event.preventDefault();

  const password =
    $("#resetPassword").value;

  const confirmPassword =
    $("#resetPasswordConfirm").value;

  if (password.length < 8) {
    toast("Password must be at least 8 characters.");
    return;
  }

  if (password !== confirmPassword) {
    toast("Passwords do not match.");
    return;
  }

  try {

    setLoading(
      true,
      "Updating your password..."
    );

    const {
      error
    } = await supabaseClient.auth.updateUser({
      password
    });

    if (error) {
      throw error;
    }

    $("#resetPasswordForm").reset();

    await supabaseClient.auth.signOut();

    showLoginPanel();

    toast(
      "Password updated. You can now log in."
    );

  } catch (error) {

    console.error(
      "PASSWORD RESET ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to update your password."
    );

  } finally {

    setLoading(false);

  }
}


async function handleLogin(event) {

  event.preventDefault();

  const submitButton =
    event.currentTarget.querySelector(
      'button[type="submit"]'
    );

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Logging in...";
  }

  setLoading(true, "Logging in, please wait.");

  const identifier =
    $("#loginIdentifier").value.trim();

  const password =
    $("#loginPassword").value;

  try {

    if (!identifier) {
      throw new Error("Please enter your email or username.");
    }

    if (!password) {
      throw new Error("Please enter your password.");
    }

    /*
     * Allow login using either email or username.
     * A leading @ is ignored for username login.
     */

    const loginIdentifier =
      identifier.startsWith("@")
        ? identifier.slice(1)
        : identifier;

    let email = loginIdentifier;

    if (!loginIdentifier.includes("@")) {

      const usernameNormalized =
        loginIdentifier.toLowerCase();

      const {
        data: profile,
        error: profileLookupError
      } = await supabaseClient.rpc(
        "find_profile_by_username",
        {
          lookup_username: usernameNormalized
        }
      );

      if (profileLookupError) {
        throw profileLookupError;
      }

      if (!profile) {
        throw new Error(
          "No account was found with that username."
        );
      }

      const {
        data: authEmail,
        error: authEmailError
      } = await supabaseClient.rpc(
        "get_login_email_by_username",
        {
          lookup_username: usernameNormalized
        }
      );

      if (authEmailError) {
        throw authEmailError;
      }

      if (!authEmail) {
        throw new Error(
          "This account does not have a login email."
        );
      }

      email = authEmail;
    }

    const {
      data,
      error
    } = await supabaseClient.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      throw new Error(error.message);
    }

    if (!data.user) {
      throw new Error(
        "Login succeeded but no user account was returned."
      );
    }

    /*
     * Supabase Auth has now authenticated the user.
     * Fetch the corresponding OweMe profile.
     */

    const {
      data: profile,
      error: profileError
    } = await supabaseClient
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .single();

    if (profileError) {
      throw new Error(
        "Login succeeded, but your OweMe profile could not be loaded."
      );
    }

    state.user = {
      userId: profile.id,
      username: profile.username,
      email: data.user.email,
      displayName: profile.display_name,
      status: profile.status,
      createdAt: profile.created_at
    };

    $("#loginForm").reset();

    showApp();

    await loadNotificationCount();
    await loadHome(null, true);

    toast("Welcome back!");

  } catch (error) {

    console.error("SUPABASE LOGIN ERROR:", error);

    toast(
      error?.message ||
      "Unable to log in."
    );

  } finally {

    setLoading(false);

    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Log In";
    }

  }
}

async function handleRegister(event) {

  event.preventDefault();

  const submitButton =
    event.currentTarget.querySelector(
      'button[type="submit"]'
    );

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Creating Account...";
  }

  setLoading(
    true,
    "Creating your account, please wait."
  );

  const email =
    $("#registerEmail").value.trim();

  const username =
    $("#registerUsername").value.trim();

  const displayName =
    $("#registerDisplayName").value.trim();

  const password =
    $("#registerPassword").value;

  const passwordConfirm =
    $("#registerPasswordConfirm").value;

  try {

    if (!email) {
      throw new Error(
        "Please enter your email address."
      );
    }

    if (!username) {
      throw new Error(
        "Please enter a username."
      );
    }

    if (!/^[A-Za-z0-9_.]+$/.test(username)) {
      throw new Error(
        "Username can only contain letters, numbers, underscore and period."
      );
    }

    if (!displayName) {
      throw new Error(
        "Please enter your display name."
      );
    }

    if (password.length < 8) {
      throw new Error(
        "Password must be at least 8 characters."
      );
    }

    if (password !== passwordConfirm) {
      throw new Error(
        "Passwords do not match."
      );
    }

    const usernameNormalized =
      username.toLowerCase();

    /*
     * Check whether the username is already used.
     */

    const {
      data: existingProfiles,
      error: usernameError
    } = await supabaseClient
      .from("profiles")
      .select("id")
      .eq(
        "username_normalized",
        usernameNormalized
      )
      .limit(1);

    if (usernameError) {
      throw usernameError;
    }

    if (
      existingProfiles &&
      existingProfiles.length
    ) {
      throw new Error(
        "That username is already taken."
      );
    }

    /*
     * Create the Supabase Auth account.
     */

    const {
      data,
      error
    } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: "https://arkhonstudio.com/oweme_app/",
        data: {
          username: username,
          display_name: displayName
        }
      }
    });

    if (error) {
      throw error;
    }

    if (!data.user) {
      throw new Error(
        "Account creation did not return a user."
      );
    }

    /*
     * The handle_new_user() database trigger already creates
     * the profile and saves the registration display name.
     * No authenticated profile update is needed here.
     */
    const savedProfile = {
      display_name: displayName
    };

    $("#registerForm").reset();

    /*
     * If email confirmation is enabled in Supabase,
     * the session will be null until the email is confirmed.
     */

    if (data.session) {

      state.user = {
        userId:
          data.user.id,

        username:
          username,

        email:
          data.user.email,

        displayName:
          savedProfile.display_name,

        status:
          "ACTIVE",

        createdAt:
          new Date().toISOString()
      };

      showApp();

      await loadHome(null, true);

      toast(
        "Account created successfully!"
      );

    } else {

      const loginPanel =
        $("#loginPanel");

      const registerPanel =
        $("#registerPanel");

      if (registerPanel) {
        registerPanel.classList.add(
          "hidden"
        );
      }

      if (loginPanel) {
        loginPanel.classList.remove(
          "hidden"
        );
      }

      toast(
        "Account created. Please check your email to confirm your account."
      );
    }

  } catch (error) {

    console.error(
      "SUPABASE REGISTRATION ERROR:",
      error
    );

    toast(
      error?.message ||
      "Unable to create your account."
    );

  } finally {

    setLoading(false);

    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent =
        "Create Account";
    }
  }
}


async function logout() {

  try {

    const { error } =
      await supabaseClient.auth.signOut();

    if (error) {
      throw error;
    }

  } catch (error) {

    console.error(
      "SUPABASE LOGOUT ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to log out."
    );

    return;
  }

  state.user = null;
  state.groups = [];
  state.invitations = [];
  state.currentGroup = null;

  showAuth();

  toast("Logged out.");
}


/* =========================================================
   NAVIGATION
   ========================================================= */

async function navigate(page) {

  state.currentPage = page;

  const content = $("#content");
  if (content) {
    content.scrollTop = 0;
  }

  setLoading(true, "Loading, please wait...");

  document.querySelectorAll(".nav-item").forEach(item => {
    item.classList.toggle(
      "active",
      item.dataset.page === page
    );
  });

  try {

    if (page === "home") {
      await loadHome();
    }

    if (page === "groups") {
      await loadGroups();
    }

    if (page === "invites") {
      await loadInvitations();
    }

    if (page === "profile") {
      renderProfile();
    }

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }
}


/* =========================================================
   HOME
   ========================================================= */

async function loadHome(initialGroups = null, force = false) {

  $("#pageTitle").textContent = "Home";

  try {

    if (initialGroups) {

      state.groups = initialGroups;
      state.groupsLoadedAt = Date.now();

    } else {

      await loadGroupsData(force);

    }


    /*
     * getGroups() now returns payment-adjusted
     * myBalance values.
     *
     * This means Home does NOT need to call
     * getSettlements() separately for every group.
     *
     * Before:
     *
     *   getGroups()
     *   getSettlements(group 1)
     *   getSettlements(group 2)
     *   getSettlements(group 3)
     *   ...
     *
     * Now:
     *
     *   getGroups()
     *
     * One request provides the group balances.
     */

    let totalBalance = 0;


    state.groups.forEach(group => {

      totalBalance +=
        Number(
          group.myBalance || 0
        );

    });


    const totalBalanceRounded =
      Number(
        totalBalance.toFixed(2)
      );

    const totalReceivables =
      Number(
        state.groups
          .reduce(
            (total, group) =>
              total +
              Number(group.receivables || 0),
            0
          )
          .toFixed(2)
      );

    const totalPayables =
      Number(
        state.groups
          .reduce(
            (total, group) =>
              total +
              Number(group.payables || 0),
            0
          )
          .toFixed(2)
      );


    $("#content").innerHTML = `

      <div class="home-intro">

        <h2>
          Hi,
          ${escapeHtml(
            state.user.displayName
          )}
        </h2>

        <p class="muted">
          Keep track of every spend and payment, all in one place.
        </p>

      </div>


      <div class="card balance-card">

        <div class="balance-label">
          ${
            totalBalanceRounded < -0.009
              ? "You still owe your group."
              : totalBalanceRounded > 0.009
                ? "Your group owes you."
                : "All settled up!"
          }
        </div>

        <div
          class="balance-number
          ${balanceClass(totalBalanceRounded)}"
        >
          ${formatBalance(totalBalanceRounded)}
        </div>

        <div class="balance-message muted">
          ${
            totalBalanceRounded < -0.009
              ? "Settle up when you're ready."
              : totalBalanceRounded > 0.009
                ? "Check if anything was missed."
                : "Nothing outstanding right now."
          }
        </div>

        <div class="home-balance-breakdown">

          <div class="home-balance-breakdown-item">
            <span>Amount you're owed</span>
            <strong>${formatMoney(totalReceivables)}</strong>
          </div>

          <div class="home-balance-breakdown-divider"></div>

          <div class="home-balance-breakdown-item">
            <span>Amount you owe</span>
            <strong>${formatMoney(totalPayables)}</strong>
          </div>

        </div>

      </div>


      <div class="section-title">
        Your groups
      </div>


      ${
        state.groups.length

          ? state.groups
              .map(renderGroupCard)
              .join("")

          : `

            <div class="card empty">

              <p>
                You don't have any groups yet.
              </p>

              <button
                class="primary-button"
                onclick="openCreateGroupModal()"
              >
                Create a Group
              </button>

            </div>

          `
      }

    `;


    bindGroupCards();


  } catch (error) {

    console.error(
      "LOAD HOME ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to load Home."
    );

  }

}

async function loadContacts() {

  $("#pageTitle").textContent = "Invites";

  try {

    const {
      data: {
        user
      },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error("Please log in first.");
    }

    /* =====================================================
       1. GET MY ACTIVE GROUPS
       ===================================================== */

    const {
      data: memberships,
      error: membershipError
    } = await supabaseClient
      .from("group_members")
      .select(`
        group_id,
        role,
        status,
        joined_at,
        groups (
          id,
          group_name,
          created_by,
          created_at,
          status
        )
      `)
      .eq("user_id", user.id)
      .eq("status", "ACTIVE");

    if (membershipError) {
      throw membershipError;
    }

    const myGroups =
      (memberships || [])
        .filter(row =>
          row.groups &&
          String(row.groups.status).toUpperCase() === "ACTIVE"
        )
        .map(row => ({
          groupId: row.groups.id,
          groupName: row.groups.group_name,
          groupCreatedAt: row.groups.created_at,
          groupStatus: row.groups.status,
          myJoinedAt: row.joined_at
        }));

    if (!myGroups.length) {
      if (!document.getElementById("invitesTabContent")) {
    $("#content").innerHTML = `
      ${renderInvitesTabs()}
      <div id="invitesTabContent"></div>
    `;
  }

  $("#invitesTabContent").innerHTML = `
        <div class="history-intro page-intro">
          <h2>Your contacts</h2>
          <p>People you've shared groups with.</p>
        </div>

        <div class="card empty">
          Debug: no active groups found.<br><br>
          Membership rows: ${memberships ? memberships.length : 0}
        </div>
      `;

      return;
    }

    /* =====================================================
       2. GET MEMBERS FROM THOSE GROUPS
       ===================================================== */

    const contactMap = {};

    for (const group of myGroups) {

      const {
        data: groupMembers,
        error: groupMembersError
      } = await supabaseClient.rpc(
        "get_group_members",
        {
          lookup_group_id: group.groupId
        }
      );

      if (groupMembersError) {
        throw groupMembersError;
      }

      (groupMembers || []).forEach(member => {

        const userId = String(member.user_id);

        if (userId === String(user.id)) {
          return;
        }

        if (!contactMap[userId]) {
          contactMap[userId] = {
            userId,
            username: member.username || "",
            displayName: member.display_name || "",
            sharedGroups: []
          };
        }

        contactMap[userId].sharedGroups.push({
          groupId: group.groupId,
          groupName: group.groupName,
          groupCreatedAt: group.groupCreatedAt,
          joinedAt: member.joined_at
        });

      });

    }

    /* =====================================================
       3. BUILD UNIQUE CONTACT LIST
       ===================================================== */

    const contactUserIds =
      Object.keys(contactMap);


    /* =====================================================
       4. BUILD CONTACT OBJECTS
       ===================================================== */

    const contacts =
      contactUserIds
        .map(userId => {

          const contact =
            contactMap[userId];

          if (!contact) {
            return null;
          }

          const sharedGroups =
            contactMap[userId].sharedGroups
              .slice()
              .sort((a, b) =>
                new Date(b.groupCreatedAt || 0) -
                new Date(a.groupCreatedAt || 0)
              );

          return {
            userId,
            username: contact.username || "",
            displayName: contact.displayName || "",
            sharedGroups
          };

        })
        .filter(Boolean)
        .sort((a, b) =>
          String(a.username).localeCompare(
            String(b.username)
          )
        );

    /* =====================================================
       6. RENDER CONTACTS
       ===================================================== */

    if (!document.getElementById("invitesTabContent")) {
    $("#content").innerHTML = `
      ${renderInvitesTabs()}
      <div id="invitesTabContent"></div>
    `;
  }

  $("#invitesTabContent").innerHTML = `
      <div class="history-intro page-intro">
        <h2>Your contacts</h2>
        <p>People you've shared groups with.</p>
      </div>

      <div class="contacts-search">
        <input
          type="search"
          id="contactsSearchInput"
          placeholder="Search contacts..."
          autocomplete="off"
        >
      </div>

      ${
        contacts.length
          ? `
            <div class="contacts-list" id="contactsList">
              ${contacts.map(renderContactCard).join("")}
            </div>
          `
          : `
            <div class="card empty">
              You don't have any contacts yet.
            </div>
          `
      }
    `;

    const searchInput =
      document.getElementById("contactsSearchInput");

    if (searchInput) {

      searchInput.addEventListener("input", event => {

        const query =
          String(event.target.value || "")
            .trim()
            .toLowerCase();

        const filtered =
          contacts.filter(contact =>
            String(contact.username || "")
              .toLowerCase()
              .includes(query) ||
            String(contact.displayName || "")
              .toLowerCase()
              .includes(query)
          );

        const list =
          document.getElementById("contactsList");

        if (!list) {
          return;
        }

        list.innerHTML =
          filtered.length
            ? filtered.map(renderContactCard).join("")
            : `
              <div class="card empty">
                No contacts found.
              </div>
            `;

      });

    }

  } catch (error) {

    console.error("LOAD CONTACTS ERROR:", error);

    toast(
      error.message ||
      "Unable to load contacts."
    );

  }

}


async function loadHistory() {

  $("#pageTitle").textContent = "History";

  try {

    const {
      data: {
        user
      },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error("Please log in first.");
    }

    const {
      data: memberships,
      error: membershipError
    } = await supabaseClient
      .from("group_members")
      .select(`
        group_id,
        status,
        groups (
          id,
          group_name,
          created_by,
          created_at,
          status
        )
      `)
      .eq("user_id", user.id)
      .eq("status", "ACTIVE");

    if (membershipError) {
      throw new Error(
        membershipError.message ||
        "Unable to load your group history."
      );
    }

    const closedGroups =
      (memberships || [])
        .filter(row =>
          row.groups &&
          String(row.groups.status).toUpperCase() === "CLOSED"
        )
        .map(row => ({
          groupId: row.groups.id,
          groupName: row.groups.group_name,
          createdBy: row.groups.created_by,
          createdAt: row.groups.created_at,
          status: row.groups.status,
          memberCount: 0
        }));

    for (const group of closedGroups) {

      const {
        data: memberRows
      } = await supabaseClient
        .from("group_members")
        .select("user_id")
        .eq("group_id", group.groupId)
        .eq("status", "ACTIVE");

      group.memberCount =
        (memberRows || []).length;
    }

    const myGroups =
      closedGroups.filter(
        group =>
          String(group.createdBy) ===
          String(user.id)
      );

    const otherGroups =
      closedGroups.filter(
        group =>
          String(group.createdBy) !==
          String(user.id)
      );

    let activeTab = "mine";

    const renderHistoryList = () => {

      const groups =
        activeTab === "mine"
          ? myGroups
          : otherGroups;

      if (!groups.length) {
        return `
          <div class="history-empty-message">
            ${
              activeTab === "mine"
                ? "You haven't closed any groups you created yet."
                : "No closed groups from your contacts yet."
            }
          </div>
        `;
      }

      return groups
        .map(group => `
          <div
            class="history-list-item"
            data-group-id="${escapeHtml(group.groupId)}"
          >

            <div class="history-list-info">

              <div class="history-list-name">
                ${escapeHtml(group.groupName)}
              </div>

              <div class="history-list-meta">
                ${Number(group.memberCount || 0)}
                member${group.memberCount === 1 ? "" : "s"}
                · Closed
              </div>

            </div>

            <div class="history-list-actions">

              <button
                type="button"
                class="history-list-icon history-view-button"
                aria-label="View group"
                title="View group"
                onclick="event.stopPropagation(); openGroup('${escapeHtml(group.groupId)}')"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="2.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                  />
                </svg>
              </button>

              <button
                type="button"
                class="history-list-icon history-delete-button"
                aria-label="Delete group"
                title="Delete group"
                onclick="event.stopPropagation(); deleteClosedGroup('${escapeHtml(group.groupId)}')"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M4 7h16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                  />
                  <path
                    d="M9 7V4h6v3"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <path
                    d="M6 7l1 13h10l1-13"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linejoin="round"
                  />
                  <path
                    d="M10 11v5M14 11v5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                  />
                </svg>
              </button>

            </div>

          </div>
        `)
        .join("");
    };

    $("#content").innerHTML = `

      <div class="history-intro">

        <h2>Your history</h2>

        <p>
          Groups you've closed and kept for the records.
        </p>

      </div>

      <div class="history-tabs">

        <button
          type="button"
          class="history-tab active"
          data-history-tab="mine"
        >
          My Groups
        </button>

        <button
          type="button"
          class="history-tab"
          data-history-tab="other"
        >
          Other Groups
        </button>

      </div>

      <div id="historyList">
        ${renderHistoryList()}
      </div>

    `;

    document
      .querySelectorAll(".history-tab")
      .forEach(button => {

        button.addEventListener("click", () => {

          activeTab =
            button.dataset.historyTab;

          document
            .querySelectorAll(".history-tab")
            .forEach(tab => {
              tab.classList.toggle(
                "active",
                tab === button
              );
            });

          const list =
            document.querySelector(
              "#historyList"
            );

          if (list) {
            list.innerHTML =
              renderHistoryList();
          }

          bindHistoryList();

        });

      });

    bindHistoryList();

  } catch (error) {

    console.error(
      "LOAD HISTORY ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to load your group history."
    );

  }

}


function bindHistoryList() {

  document
    .querySelectorAll(".history-list-item")
    .forEach(item => {

      item.addEventListener("click", () => {
        openGroup(
          item.dataset.groupId
        );
      });

    });

}


async function loadGroups() {

  $("#pageTitle").textContent = "Groups";

  await loadGroupsData();

  window.owemeGroupsSection = "mine";
  window.owemeGroupSubtab = "mine";

  const renderGroupsContent = () => {

    const groups =
      window.owemeGroupSubtab === "mine"
        ? state.groups.filter(
            group =>
              String(group.createdBy) ===
              String(state.user.userId)
          )
        : state.groups.filter(
            group =>
              String(group.createdBy) !==
              String(state.user.userId)
          );

    return groups.length
      ? groups.map(renderGroupCard).join("")
      : `
        <div class="card empty">
          ${
            window.owemeGroupSubtab === "mine"
              ? "You haven't created any groups yet."
              : "You aren't part of any groups created by your contacts yet."
          }
        </div>
      `;
  };

  const renderSectionTabs = () => `
    <div class="groups-tab-container groups-section-tabs">

      <button
        type="button"
        class="groups-tab ${window.owemeGroupsSection === "mine" ? "active" : ""}"
        data-section-tab="mine"
        onclick="switchGroupsSectionTab('mine')"
      >
        My Active Groups
      </button>

      <button
        type="button"
        class="groups-tab ${window.owemeGroupsSection === "history" ? "active" : ""}"
        data-section-tab="history"
        onclick="switchGroupsSectionTab('history')"
      >
        My Past Groups
      </button>

    </div>
  `;

  const renderSubTabs = () => `
    <div class="history-tabs groups-sub-tabs">

      <button
        type="button"
        class="history-tab ${window.owemeGroupSubtab === "mine" ? "active" : ""}"
        onclick="switchGroupsSubTab('mine')"
      >
        Own Group
      </button>

      <button
        type="button"
        class="history-tab ${window.owemeGroupSubtab === "other" ? "active" : ""}"
        onclick="switchGroupsSubTab('other')"
      >
        Others Group
      </button>

    </div>
  `;

  $("#content").innerHTML = `

    ${renderSectionTabs()}

    ${renderSubTabs()}

    <div id="groupsTabContent">
      ${renderGroupsContent()}
    </div>

  `;

  bindGroupCards();

}


async function switchGroupsSectionTab(section) {

  window.owemeGroupsSection =
    section === "history"
      ? "history"
      : "mine";

  window.owemeGroupSubtab = "mine";

  const subTabs =
    document.querySelectorAll(
      ".groups-sub-tabs .history-tab"
    );

  subTabs.forEach(button => {
    button.classList.toggle(
      "active",
      button.textContent.trim() === "Own Group"
    );
  });

  const sectionTabs =
    document.querySelectorAll(
      ".groups-section-tabs .groups-tab"
    );

  sectionTabs.forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.sectionTab ===
      window.owemeGroupsSection
    );
  });

  const container =
    document.querySelector(
      "#groupsTabContent"
    );

  if (!container) return;

  if (window.owemeGroupsSection === "history") {
    await renderGroupsHistoryTab(container);
  } else {
    await renderGroupsOwnTab(container);
  }

}


async function switchGroupsSubTab(subtab) {

  window.owemeGroupSubtab =
    subtab === "other"
      ? "other"
      : "mine";

  const tabs =
    document.querySelectorAll(
      ".groups-sub-tabs .history-tab"
    );

  tabs.forEach(button => {
    const text =
      button.textContent.trim();

    button.classList.toggle(
      "active",
      (
        window.owemeGroupSubtab === "mine" &&
        text === "Own Group"
      ) ||
      (
        window.owemeGroupSubtab === "other" &&
        text === "Others Group"
      )
    );
  });

  const container =
    document.querySelector(
      "#groupsTabContent"
    );

  if (!container) return;

  if (window.owemeGroupsSection === "history") {
    await renderGroupsHistoryTab(container);
  } else {
    await renderGroupsOwnTab(container);
  }

}


async function renderGroupsOwnTab(container) {

  const groups =
    window.owemeGroupSubtab === "mine"
      ? state.groups.filter(
          group =>
            String(group.createdBy) ===
            String(state.user.userId)
        )
      : state.groups.filter(
          group =>
            String(group.createdBy) !==
            String(state.user.userId)
        );

  container.innerHTML =
    groups.length
      ? groups.map(renderGroupCard).join("")
      : `
        <div class="card empty">
          ${
            window.owemeGroupSubtab === "mine"
              ? "You haven't created any groups yet."
              : "You aren't part of any groups created by your contacts yet."
          }
        </div>
      `;

  bindGroupCards();

}


async function renderGroupsHistoryTab(container) {

  try {

    const {
      data: {
        user
      },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error("Please log in first.");
    }

    const {
      data: memberships,
      error: membershipError
    } = await supabaseClient
      .from("group_members")
      .select(`
        group_id,
        status,
        groups (
          id,
          group_name,
          created_by,
          created_at,
          status
        )
      `)
      .eq("user_id", user.id)
      .eq("status", "ACTIVE");

    if (membershipError) {
      throw new Error(
        membershipError.message ||
        "Unable to load your group history."
      );
    }

    const closedGroups =
      (memberships || [])
        .filter(row =>
          row.groups &&
          String(row.groups.status).toUpperCase() === "CLOSED"
        )
        .map(row => ({
          groupId: row.groups.id,
          groupName: row.groups.group_name,
          createdBy: row.groups.created_by,
          createdAt: row.groups.created_at,
          status: row.groups.status,
          memberCount: 0
        }));

    for (const group of closedGroups) {

      const {
        data: memberRows
      } = await supabaseClient
        .from("group_members")
        .select("user_id")
        .eq("group_id", group.groupId)
        .eq("status", "ACTIVE");

      group.memberCount =
        (memberRows || []).length;
    }

    const groups =
      window.owemeGroupSubtab === "mine"
        ? closedGroups.filter(
            group =>
              String(group.createdBy) ===
              String(user.id)
          )
        : closedGroups.filter(
            group =>
              String(group.createdBy) !==
              String(user.id)
          );

    if (!groups.length) {

      container.innerHTML = `
        <div class="history-empty-message">
          ${
            window.owemeGroupSubtab === "mine"
              ? "You haven't closed any groups you created yet."
              : "No closed groups from your contacts yet."
          }
        </div>
      `;

      return;
    }

    container.innerHTML = groups
      .map(group => `
        <div
          class="history-list-item"
          data-group-id="${escapeHtml(group.groupId)}"
        >

          <div class="history-list-info">

            <div class="history-list-name">
              ${escapeHtml(group.groupName)}
            </div>

            <div class="history-list-meta">
              ${Number(group.memberCount || 0)}
              member${group.memberCount === 1 ? "" : "s"}
              · Closed
            </div>

          </div>

          <div class="history-list-actions">

            <button
              type="button"
              class="history-list-icon history-view-button"
              aria-label="View group"
              title="View group"
              onclick="event.stopPropagation(); openGroup('${escapeHtml(group.groupId)}')"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                <circle
                  cx="12"
                  cy="12"
                  r="2.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                />
              </svg>
            </button>

            <button
              type="button"
              class="history-list-icon history-delete-button"
              aria-label="Delete group"
              title="Delete group"
              onclick="event.stopPropagation(); deleteClosedGroup('${escapeHtml(group.groupId)}')"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M4 7h16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                />
                <path
                  d="M9 7V4h6v3"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                <path
                  d="M6 7l1 13h10l1-13"
                  fill="none"
                  stroke="currentColor"
                  stroke-linejoin="round"
                />
                <path
                  d="M10 11v5M14 11v5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                />
              </svg>
            </button>

          </div>

        </div>
      `)
      .join("");

    bindHistoryList();

  } catch (error) {

    console.error(
      "LOAD GROUP HISTORY TAB ERROR:",
      error
    );

    container.innerHTML = `
      <div class="card empty">
        ${escapeHtml(
          error.message ||
          "Unable to load your group history."
        )}
      </div>
    `;

  }

}

async function loadGroupsData(force = false) {

  const cacheAge =
    Date.now() - state.groupsLoadedAt;

  if (
    !force &&
    state.groupsLoadedAt &&
    cacheAge < 30000
  ) {
    return state.groups;
  }


  /* =====================================================
     1. GET CURRENT SUPABASE USER
     ===================================================== */

  const {
    data: {
      user
    },
    error: sessionError
  } = await supabaseClient.auth.getUser();

  if (sessionError || !user) {
    throw new Error(
      "Your Supabase session has expired."
    );
  }


  /* =====================================================
     2. GET GROUP MEMBERSHIPS
     ===================================================== */

  const {
    data: memberships,
    error: membershipError
  } = await supabaseClient
    .from("group_members")
    .select(`
      group_id,
      role,
      status,
      joined_at,
      groups (
        id,
        group_name,
        created_by,
        created_at,
        status
      )
    `)
    .eq("user_id", user.id)
    .eq("status", "ACTIVE");


  if (membershipError) {

    console.error(
      "LOAD GROUPS ERROR:",
      membershipError
    );

    throw new Error(
      membershipError.message ||
      "Unable to load your groups."
    );

  }


  /* =====================================================
     3. BUILD GROUP LIST
     ===================================================== */

  const groups =
    (memberships || [])
      .filter(row =>
        row.groups &&
        String(row.groups.status).toUpperCase() === "ACTIVE"
      )
      .map(row => ({

        groupId:
          row.groups.id,

        groupName:
          row.groups.group_name,

        createdBy:
          row.groups.created_by,

        createdAt:
          row.groups.created_at,

        status:
          row.groups.status,

        role:
          row.role,

        memberCount:
          0,

        myBalance:
          0,

        amountSpent:
          0,

        amountYouSpent:
          0,

        payables:
          0,

        receivables:
          0

      }));


  /* =====================================================
     4. GET MEMBER COUNTS + CURRENT BALANCES
     ===================================================== */

  for (const group of groups) {

    const {
      data: memberRows,
      error: memberError
    } = await supabaseClient
      .from("group_members")
      .select("user_id")
      .eq("group_id", group.groupId)
      .eq("status", "ACTIVE");


    if (memberError) {

      console.error(
        "LOAD MEMBER COUNT ERROR:",
        memberError
      );

      continue;

    }


    group.memberCount =
      (memberRows || []).length;


    /* =================================================
       GET ACTIVE EXPENSES FOR THIS GROUP
       ================================================= */

    const {
      data: expenseRows,
      error: expenseError
    } = await supabaseClient
      .from("expenses")
      .select(`
        id,
        paid_by_user_id,
        created_by,
        amount,
        expense_participants (
          user_id,
          share_amount
        )
      `)
      .eq("group_id", group.groupId)
      .eq("status", "ACTIVE");


    if (expenseError) {

      console.error(
        "LOAD GROUP EXPENSES ERROR:",
        expenseError
      );

      continue;

    }


    let totalPaid = 0;
    let totalShare = 0;
    let amountSpent = 0;


    (expenseRows || [])
      .forEach(expense => {

        amountSpent +=
          Number(
            expense.amount || 0
          );

        if (
          expense.paid_by_user_id ===
          user.id
        ) {

          totalPaid +=
            Number(
              expense.amount || 0
            );

        }


        (expense.expense_participants || [])
          .forEach(participant => {

            if (
              participant.user_id ===
              user.id
            ) {

              totalShare +=
                Number(
                  participant.share_amount || 0
                );

            }

          });

      });


    group.amountSpent =
      Number(
        amountSpent.toFixed(2)
      );

    group.amountYouSpent =
      Number(
        totalPaid.toFixed(2)
      );


    const {
      data: paymentRows,
      error: paymentError
    } = await supabaseClient
      .from("payment_submissions")
      .select(`
        payer_user_id,
        recipient_user_id,
        amount_paid,
        status
      `)
      .eq("group_id", group.groupId)
      .eq("status", "CONFIRMED");


    if (paymentError) {

      console.error(
        "LOAD GROUP PAYMENTS ERROR:",
        paymentError
      );

    }


    let paymentAdjustment = 0;


    (paymentRows || [])
      .forEach(payment => {

        const amountPaid =
          Number(
            payment.amount_paid || 0
          );

        if (amountPaid <= 0) {
          return;
        }

        if (
          payment.payer_user_id ===
          user.id
        ) {

          paymentAdjustment +=
            amountPaid;

        }

        if (
          payment.recipient_user_id ===
          user.id
        ) {

          paymentAdjustment -=
            amountPaid;

        }

      });


    /*
     * Calculate Payables / Receivables from direct obligations.
     *
     * Reciprocal obligations are netted between the same users.
     *
     * Example:
     *   You owe Kofi      ₱297.00
     *   Kofi owes you      ₱45.50
     *   ---------------------------
     *   Net payable       ₱251.50
     *
     * Do not use totalPaid - totalShare here because that
     * produces a single group balance rather than showing
     * who actually owes whom.
     */

    const obligations = {};

    (expenseRows || []).forEach(expense => {

      const payerId =
        String(expense.paid_by_user_id);

      (expense.expense_participants || [])
        .forEach(participant => {

          const participantId =
            String(participant.user_id);

          const shareAmount =
            Number(participant.share_amount || 0);

          if (
            participantId === payerId ||
            shareAmount <= 0
          ) {
            return;
          }

          const key =
            `${participantId}|${payerId}`;

          if (!obligations[key]) {
            obligations[key] = {
              fromUserId: participantId,
              toUserId: payerId,
              amount: 0
            };
          }

          obligations[key].amount =
            Math.round(
              (
                obligations[key].amount +
                shareAmount
              ) * 100
            ) / 100;

        });

    });


    /*
     * Build reciprocal pairs.
     */

    const pairBalances = {};

    Object.values(obligations)
      .forEach(obligation => {

        const fromUserId =
          String(obligation.fromUserId);

        const toUserId =
          String(obligation.toUserId);

        const pairKey =
          [fromUserId, toUserId]
            .sort()
            .join("|");

        if (!pairBalances[pairKey]) {
          pairBalances[pairKey] = {};
        }

        pairBalances[pairKey][
          `${fromUserId}|${toUserId}`
        ] =
          Number(obligation.amount || 0);

      });


    let calculatedPayables = 0;
    let calculatedReceivables = 0;


    Object.values(pairBalances)
      .forEach(pair => {

        const directions =
          Object.keys(pair);

        if (!directions.length) {
          return;
        }

        if (directions.length === 1) {

          const direction =
            directions[0];

          const amount =
            Number(pair[direction] || 0);

          const [
            fromUserId,
            toUserId
          ] =
            direction.split("|");

          if (fromUserId === String(user.id)) {
            calculatedPayables += amount;
          }

          if (toUserId === String(user.id)) {
            calculatedReceivables += amount;
          }

          return;
        }


        const firstDirection =
          directions[0];

        const secondDirection =
          directions[1];

        const firstAmount =
          Number(pair[firstDirection] || 0);

        const secondAmount =
          Number(pair[secondDirection] || 0);

        const [
          firstFrom,
          firstTo
        ] =
          firstDirection.split("|");

        const [
          secondFrom,
          secondTo
        ] =
          secondDirection.split("|");


        if (firstAmount > secondAmount) {

          const net =
            firstAmount - secondAmount;

          if (firstFrom === String(user.id)) {
            calculatedPayables += net;
          }

          if (firstTo === String(user.id)) {
            calculatedReceivables += net;
          }

        } else if (secondAmount > firstAmount) {

          const net =
            secondAmount - firstAmount;

          if (secondFrom === String(user.id)) {
            calculatedPayables += net;
          }

          if (secondTo === String(user.id)) {
            calculatedReceivables += net;
          }

        }

      });


    group.payables =
      Number(
        calculatedPayables.toFixed(2)
      );

    group.receivables =
      Number(
        calculatedReceivables.toFixed(2)
      );

    group.myBalance =
      Number(
        (
          group.receivables -
          group.payables
        ).toFixed(2)
      );

  }


  /* =====================================================
     5. SAVE TO STATE
     ===================================================== */

  state.groups =
    groups;

  state.groupsLoadedAt =
    Date.now();


  return state.groups;

}


function renderGroupCard(group) {

  return `
    <div
      class="card group-card"
      data-group-id="${escapeHtml(group.groupId)}"
    >

      <div style="flex:1;">
        <h3>${escapeHtml(group.groupName)}</h3>

        <p>
          ${Number(group.memberCount || 0)}
          members
        </p>

        <div style="margin-top:8px;">
          <div>
            <strong>Amount Spent</strong>
            ${formatMoney(group.amountSpent || 0)}
          </div>

          <div style="margin-top:4px;">
            <strong>Amount You Spent</strong>
            ${formatMoney(group.amountYouSpent || 0)}
          </div>
        </div>

        <div
          style="
            margin-top:10px;
            font-size:13px;
            line-height:1.7;
            color:var(--muted);
          "
        >
          <div>
            Your Payables:
            ${formatMoney(group.payables || 0)}
          </div>

          <div>
            Your Receivables:
            ${formatMoney(group.receivables || 0)}
          </div>
        </div>
      </div>



    </div>
  `;
}


function bindGroupCards() {

  document.querySelectorAll(".group-card").forEach(card => {

    card.addEventListener("click", () => {
      openGroup(card.dataset.groupId);
    });

  });

}


/* =========================================================
   GROUP PAGE
   ========================================================= */

async function openGroup(groupId) {

  setLoading(
    true,
    "Opening group, please wait..."
  );

  try {

    /* =====================================================
       1. GET CURRENT SUPABASE USER
       ===================================================== */

    const {
      data: {
        user
      },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error("Please log in first.");
    }


    /* =====================================================
       2. GET GROUP
       ===================================================== */

    const {
      data: group,
      error: groupError
    } = await supabaseClient
      .from("groups")
      .select(`
        id,
        group_name,
        created_by,
        created_at,
        status
      `)
      .eq("id", groupId)
      .single();

    if (groupError) {
      console.error(
        "GET GROUP ERROR:",
        groupError
      );

      throw new Error(
        groupError.message ||
        "Unable to load group."
      );
    }


    /* =====================================================
       3. GET GROUP MEMBERS
       ===================================================== */

    const {
      data: memberRows,
      error: membersError
    } = await supabaseClient
      .rpc("get_group_members", {
        lookup_group_id: groupId
      });

    if (membersError) {
      console.error(
        "GET GROUP MEMBERS ERROR:",
        membersError
      );

      throw new Error(
        membersError.message ||
        "Unable to load group members."
      );
    }


    const members =
      (memberRows || [])
        .map(row => ({
          userId: row.user_id,
          username: row.username,
          displayName: row.display_name,
          role: row.role,
          joinedAt: row.joined_at
        }));


    /* =====================================================
       4. GET EXPENSES
       ===================================================== */

    const {
      data: expenseRows,
      error: expensesError
    } = await supabaseClient
      .from("expenses")
      .select(`
        id,
        group_id,
        paid_by_user_id,
        amount,
        description,
        created_at,
        created_by,
        status,
        receipt_file_url,
        expense_participants (
          expense_id,
          user_id,
          share_amount,
          profiles (
            id,
            username,
            display_name
          )
        )
      `)
      .eq("group_id", groupId)
      .eq("status", "ACTIVE")
      .order("created_at", {
        ascending: false
      });

    if (expensesError) {
      console.error(
        "GET EXPENSES ERROR:",
        expensesError
      );

      throw new Error(
        expensesError.message ||
        "Unable to load expenses."
      );
    }


    /* =====================================================
       5. CONVERT SUPABASE EXPENSES TO OLD APP FORMAT
       ===================================================== */

    const expenses =
      (expenseRows || []).map(expense => {

        const payer =
          members.find(
            member =>
              member.userId ===
              expense.paid_by_user_id
          );

        return {

          expenseId: expense.id,

          groupId: expense.group_id,

          paidByUserId:
            expense.paid_by_user_id,

          paidByUsername:
            payer?.username || "",

          paidByDisplayName:
            payer?.displayName || "",

          amount:
            Number(expense.amount),

          description:
            expense.description || "",

          createdAt:
            expense.created_at,

          createdBy:
            expense.created_by,

          status:
            expense.status,

          receiptFileUrl:
            expense.receipt_file_url || "",

          participants:
            (expense.expense_participants || [])
              .map(participant => ({
                userId:
                  participant.user_id,

                username:
                  participant.profiles?.username ||
                  "",

                displayName:
                  participant.profiles?.display_name ||
                  "",

                shareAmount:
                  Number(
                    participant.share_amount
                  )
              }))

        };

      });


    /* =====================================================
       6. CALCULATE BALANCES
       ===================================================== */

    const balanceMap = {};

    members.forEach(member => {

      balanceMap[member.userId] = {

        userId:
          member.userId,

        username:
          member.username,

        displayName:
          member.displayName,

        totalPaid: 0,

        totalShare: 0,

        balance: 0

      };

    });


    expenses.forEach(expense => {

      if (
        balanceMap[
          expense.paidByUserId
        ]
      ) {

        balanceMap[
          expense.paidByUserId
        ].totalPaid +=
          Number(expense.amount);

      }


      (expense.participants || [])
        .forEach(participant => {

          if (
            balanceMap[
              participant.userId
            ]
          ) {

            balanceMap[
              participant.userId
            ].totalShare +=
              Number(
                participant.shareAmount
              );

          }

        });

    });


    const balances =
      Object.values(balanceMap)
        .map(balance => {

          balance.balance =
            Number(
              (
                balance.totalPaid -
                balance.totalShare
              ).toFixed(2)
            );

          balance.totalPaid =
            Number(
              balance.totalPaid.toFixed(2)
            );

          balance.totalShare =
            Number(
              balance.totalShare.toFixed(2)
            );

          return balance;

        });


    /* =====================================================
       7. GET PAYMENT SUBMISSIONS
       ===================================================== */

    const {
      data: paymentRows,
      error: paymentError
    } = await supabaseClient
      .from("payment_submissions")
      .select(`
        id,
        settlement_id,
        group_id,
        payer_user_id,
        recipient_user_id,
        payment_option,
        payment_detail_id,
        amount_due,
        amount_paid,
        proof_file_url,
        notes,
        status,
        submitted_at,
        confirmed_at,
        rejected_at,
        rejection_reason
      `)
      .eq("group_id", groupId)
      .order("submitted_at", {
        ascending: false
      });

    if (paymentError) {
      console.error(
        "GET PAYMENT SUBMISSIONS ERROR:",
        paymentError
      );

      throw new Error(
        paymentError.message ||
        "Unable to load payment submissions."
      );
    }


    /* =====================================================
       7A. APPLY CONFIRMED PAYMENTS TO BALANCES
       ===================================================== */

    (paymentRows || [])
      .filter(
        payment =>
          String(payment.status).toUpperCase() ===
          "CONFIRMED"
      )
      .forEach(payment => {

        const amountPaid =
          Number(payment.amount_paid || 0);

        if (amountPaid <= 0) {
          return;
        }

        if (balanceMap[payment.payer_user_id]) {
          balanceMap[payment.payer_user_id].balance +=
            amountPaid;
        }

        if (balanceMap[payment.recipient_user_id]) {
          balanceMap[payment.recipient_user_id].balance -=
            amountPaid;
        }

      });

    const adjustedBalances =
      Object.values(balanceMap)
        .map(balance => {

          balance.balance =
            Number(
              balance.balance.toFixed(2)
            );

          return balance;

        });

    /* =====================================================
       8. CALCULATE SETTLEMENTS
       ===================================================== */

    const balancesForSettlement =
      adjustedBalances;

    const debtors =
      balancesForSettlement
        .filter(
          balance =>
            balance.balance < -0.009
        )
        .map(balance => ({
          userId:
            balance.userId,

          amount:
            Math.abs(balance.balance)
        }))
        .sort(
          (a, b) =>
            b.amount - a.amount
        );


    const creditors =
      balancesForSettlement
        .filter(
          balance =>
            balance.balance > 0.009
        )
        .map(balance => ({
          userId:
            balance.userId,

          amount:
            balance.balance
        }))
        .sort(
          (a, b) =>
            b.amount - a.amount
        );


    const settlementMap = {};


    let debtorIndex = 0;
    let creditorIndex = 0;


    while (
      debtorIndex < debtors.length &&
      creditorIndex < creditors.length
    ) {

      const debtor =
        debtors[debtorIndex];

      const creditor =
        creditors[creditorIndex];


      const amount =
        Number(
          Math.min(
            debtor.amount,
            creditor.amount
          ).toFixed(2)
        );


      if (amount > 0) {

        const {
          data: settlementId,
          error: settlementError
        } = await supabaseClient.rpc(
          "ensure_settlement",
          {
            p_group_id:
              groupId,

            p_from_user_id:
              debtor.userId,

            p_to_user_id:
              creditor.userId,

            p_amount:
              amount
          }
        );

        if (settlementError) {
          console.error(
            "ENSURE SETTLEMENT ERROR:",
            settlementError
          );

          throw new Error(
            settlementError.message ||
            "Unable to create settlement."
          );
        }


        settlementMap[
          settlementId
        ] = {

          settlementId,

          groupId,

          fromUserId:
            debtor.userId,

          toUserId:
            creditor.userId,

          amount,

          status: "UNPAID",

          createdAt:
            new Date().toISOString(),

          paidAt: null

        };


        debtor.amount =
          Number(
            (
              debtor.amount -
              amount
            ).toFixed(2)
          );


        creditor.amount =
          Number(
            (
              creditor.amount -
              amount
            ).toFixed(2)
          );

      }


      if (
        debtor.amount <= 0.009
      ) {
        debtorIndex++;
      }


      if (
        creditor.amount <= 0.009
      ) {
        creditorIndex++;
      }

    }


    /* =====================================================
       9. FINALIZE SETTLEMENTS
       ===================================================== */

    /*
     * Use the Supabase settlement calculation as the single
     * source of truth. This includes reciprocal netting, so
     * obligations between the same two users are offset.
     *
     * Example:
     *   You -> Kofi     297.00
     *   Kofi -> You      45.50
     *   Net             251.50
     *
     * Unrelated settlements (e.g. NADZ -> Kofi) are excluded.
     */
    const settlementResult =
      await getSettlementsFromSupabase(
        group.id
      );

    const settlements =
      settlementResult?.settlements ||
      settlementResult?.data?.settlements ||
      [];


    /* =====================================================
       10. CREATE TRANSACTIONS
       ===================================================== */

    const expenseTransactions =
      expenses
        .map(expense => {

          if (
            typeof expenseToTransaction ===
            "function"
          ) {

            return expenseToTransaction(
              expense
            );

          }

          return {

            type: "EXPENSE",

            transactionId:
              expense.expenseId,

            expenseId:
              expense.expenseId,

            groupId:
              expense.groupId,

            amount:
              expense.amount,

            description:
              expense.description,

            fromUserId:
              expense.paidByUserId,

            createdAt:
              expense.createdAt,

            status:
              expense.status

          };

        });

    const paymentTransactions =
      (paymentRows || []).map(payment => {

        const payer =
          members.find(
            member =>
              member.userId ===
              payment.payer_user_id
          );

        const recipient =
          members.find(
            member =>
              member.userId ===
              payment.recipient_user_id
          );

        if (
          String(payment.status || "").toUpperCase() ===
          "CANCELLED"
        ) {
          return null;
        }

        return {

          transactionId:
            payment.id,

          paymentSubmissionId:
            payment.id,

          settlementId:
            payment.settlement_id,

          groupId:
            payment.group_id,

          type:
            "PAYMENT",

          date:
            payment.submitted_at ||
            payment.confirmed_at ||
            payment.rejected_at ||
            "",

          description:
            "Settlement payment",

          fromUserId:
            payment.payer_user_id,

          fromUsername:
            payer?.username || "",

          fromDisplayName:
            payer?.displayName || "",

          toUserId:
            payment.recipient_user_id,

          toUsername:
            recipient?.username || "",

          toDisplayName:
            recipient?.displayName || "",

          amount:
            Number(payment.amount_paid || 0),

          amountDue:
            Number(payment.amount_due || 0),

          paymentOption:
            payment.payment_option || "",

          paymentDetailId:
            payment.payment_detail_id,

          proofFileUrl:
            payment.proof_file_url || "",

          notes:
            payment.notes || "",

          status:
            payment.status,

          submittedAt:
            payment.submitted_at,

          confirmedAt:
            payment.confirmed_at,

          rejectedAt:
            payment.rejected_at,

          rejectionReason:
            payment.rejection_reason || ""

        };

      }).filter(Boolean);

    const transactions =
      [
        ...expenseTransactions,
        ...paymentTransactions
      ].sort(
        (a, b) =>
          new Date(b.date || 0) -
          new Date(a.date || 0)
      );


    /* =====================================================
       11. BUILD GROUP RESULT
       ===================================================== */

    const totalSpent =
      expenses.reduce(
        (total, expense) =>
          total +
          Number(expense.amount || 0),
        0
      );


    const currentMember =
      members.find(
        member =>
          member.userId === user.id
      );


    const currentUserBalance =
      adjustedBalances.find(
        balance =>
          balance.userId === user.id
      );


    const groupResult = {

  group: {

    groupId:
      group.id,

    groupName:
      group.group_name,

    createdBy:
      group.created_by,

    createdAt:
      group.created_at,

    status:
      group.status,

    currentUserRole:
      currentMember?.role ||
      null,

    memberCount:
      members.length,

    totalSpent:
      Number(
        totalSpent.toFixed(2)
      ),

    myBalance:
      Number(
        currentUserBalance?.balance ||
        0
      )

  },

  members,

  expenses,

  balances:
    adjustedBalances,

  settlements,

  transactions

};


    /* =====================================================
       12. SAVE CURRENT GROUP
       ===================================================== */

    state.currentGroup =
      groupResult;


    /* =====================================================
       13. RENDER GROUP
       ===================================================== */

    renderGroup();


  } catch (error) {

    console.error(
      "OPEN GROUP ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to open group."
    );

  } finally {

    setLoading(false);

  }

}


function simpleHash(value) {

  let hash = 0;

  for (let i = 0; i < value.length; i++) {

    hash =
      (
        (hash << 5) -
        hash +
        value.charCodeAt(i)
      ) |
      0;

  }

  return Math.abs(hash)
    .toString(16)
    .padStart(24, "0")
    .substring(0, 24);

}


async function refreshCurrentGroup() {

  if (!state.currentGroup) return;

  await openGroup(state.currentGroup.group.groupId);
}


async function loadGroupTransactions() {

  const container =
    $("#transactionsTableBody");

  if (!container) {
    return;
  }

  try {

    const transactions =
      state.currentGroup.transactions ||
      [];

    if (!transactions.length) {

      container.innerHTML = `
        <tr>
          <td
            colspan="8"
            class="muted"
            style="text-align:center;padding:30px;"
          >
            No transactions yet.
          </td>
        </tr>
      `;

      return;
    }

    container.innerHTML =
      transactions
        .map(renderTransactionRow)
        .join("");

  } catch (error) {

    console.error(
      "LOAD GROUP TRANSACTIONS ERROR:",
      error
    );

    container.innerHTML = `
      <tr>
        <td
          colspan="8"
          class="muted"
          style="text-align:center;padding:30px;"
        >
          ${escapeHtml(
            error.message ||
            "Unable to load transactions."
          )}
        </td>
      </tr>
    `;

  }

}


function extractTransactions(result) {

  const candidates = [
    result?.transactions,
    result?.data?.transactions,
    result?.data?.data?.transactions
  ];

  return candidates.find(
    value => Array.isArray(value)
  ) || [];

}


function expenseToTransaction(expense) {

  return {

    transactionId:
      expense.expenseId,

    type:
      "EXPENSE",

    date:
      expense.createdAt ||
      expense.date ||
      "",

    description:
      expense.description ||
      "Expense",

    fromUserId:
      expense.paidByUserId ||
      "",

    fromUsername:
      expense.paidByUsername ||
      "",

    fromDisplayName:
      expense.paidByDisplayName ||
      "",

    toUserId:
      "",

    toUsername:
      "Group",

    amount:
      Number(expense.amount || 0),

    status:
      "RECORDED",

    expenseId:
      expense.expenseId,

    createdBy:
      expense.createdBy ||
      expense.created_by ||
      "",

    participants:
      (expense.participants || []).map(participant => ({
        userId:
          participant.userId,

        username:
          participant.username || "",

        displayName:
          participant.displayName || "",

        shareAmount:
          Number(participant.shareAmount || 0)
      }))

  };

}

function renderTransactionRow(transaction) {

  const isExpense =
    String(transaction.type).toUpperCase() ===
    "EXPENSE";

  const isPayment =
    String(transaction.type).toUpperCase() ===
    "PAYMENT";

  const currentUserId =
    String(state.user.userId);

  const fromUserId =
    String(transaction.fromUserId || "");

  const toUserId =
    String(transaction.toUserId || "");

  const fromLabel =
    fromUserId === currentUserId
      ? "You"
      : transaction.fromDisplayName
        ? escapeHtml(transaction.fromDisplayName)
        : "—";

  const toLabel =
    toUserId === currentUserId
      ? "You"
      : transaction.toDisplayName
        ? escapeHtml(transaction.toDisplayName)
        : isExpense
          ? "Group"
          : "—";

  let statusHtml = "Recorded";

  if (isPayment) {

    const status =
      String(transaction.status || "").toUpperCase();

    if (status === "SUBMITTED") {

      statusHtml =
        toUserId === currentUserId
          ? `<span class="status-pending">Pending confirmation</span>`
          : `<span class="status-pending">Pending</span>`;

    } else if (status === "CONFIRMED") {

      statusHtml =
        `<span class="status-confirmed">Confirmed</span>`;

    } else if (status === "REJECTED") {

      statusHtml =
        `<span class="status-rejected">Rejected</span>`;

    }

  }

  let actionHtml = "";

  if (isExpense) {

    const canDeleteExpense =
      String(transaction.createdBy || "") ===
      currentUserId;

    actionHtml = `
      <div class="table-action-buttons">
        <button
          type="button"
          class="table-action-button view-action-button"
          onclick="openExpenseDetails('${escapeHtml(
            transaction.expenseId
          )}')"
        >
          View
        </button>

        ${
          canDeleteExpense
            ? `
              <button
                type="button"
                class="table-action-button delete-action-button"
                onclick="deleteExpense('${escapeHtml(
                  transaction.expenseId
                )}')"
              >
                Delete
              </button>
            `
            : ""
        }
      </div>
    `;

  } else if (isPayment) {

    const status =
      String(transaction.status || "").toUpperCase();

    const isPayer =
      String(transaction.fromUserId || "") ===
      currentUserId;

    const viewButton = `
      <button
        type="button"
        class="table-action-button view-action-button"
        onclick="openPaymentTransaction('${escapeHtml(
          transaction.paymentSubmissionId
        )}')"
      >
        View
      </button>
    `;

    const cancelButton =
      status === "SUBMITTED" && isPayer
        ? `
          <button
            type="button"
            class="table-action-button"
            onclick="cancelPayment('${escapeHtml(
              transaction.paymentSubmissionId
            )}')"
          >
            Cancel
          </button>
        `
        : "";

    const reviewButton =
      status === "SUBMITTED" &&
      toUserId === currentUserId
        ? `
          <button
            type="button"
            class="table-action-button review-action-button"
            onclick="reviewPayment('${escapeHtml(
              transaction.paymentSubmissionId
            )}')"
          >
            Review
          </button>
        `
        : "";

    actionHtml = `
      <div class="table-action-buttons">
        ${
          reviewButton ||
          viewButton
        }
        ${cancelButton}
      </div>
    `;

  }

  return `
    <tr>
      <td>${escapeHtml(formatTransactionDate(transaction.date))}</td>
      <td>${isExpense ? "Expense" : "Payment"}</td>
      <td>${escapeHtml(transaction.description || "—")}</td>
      <td>${fromLabel}</td>
      <td>${toLabel}</td>
      <td><strong>${formatMoney(transaction.amount)}</strong></td>
      <td>${statusHtml}</td>
      <td>${actionHtml}</td>
    </tr>
  `;

}


async function openExpenseDetails(expenseId) {

  const expenses =
    state.currentGroup?.expenses || [];

  const expense =
    expenses.find(item =>
      String(item.expenseId || item.id) ===
      String(expenseId)
    );

  if (!expense) {
    toast("Expense not found.");
    return;
  }

  const participants =
    expense.participants || [];

  openModal(`
    <h2>Expense Details</h2>

    <div class="card" style="margin-top:16px;">

      <div class="muted">Description</div>
      <div style="font-weight:600;margin-top:4px;">
        ${escapeHtml(expense.description || "Expense")}
      </div>

      <div class="muted" style="margin-top:16px;">
        Amount
      </div>
      <div style="font-size:24px;font-weight:700;margin-top:4px;">
        ${formatMoney(expense.amount)}
      </div>

      <div class="muted" style="margin-top:16px;">
        Paid by
      </div>
      <div style="margin-top:4px;">
        ${escapeHtml(expense.paidByDisplayName || "Unknown")}
      </div>

      ${
        expense.receiptFileUrl
          ? `
            <div class="muted" style="margin-top:18px;">
              Receipt
            </div>

            <button
              type="button"
              class="secondary-button"
              id="viewExpenseReceiptButton"
              style="margin-top:8px;"
            >
              📎 View Receipt
            </button>
          `
          : ""
      }

    </div>

    <h3 style="margin-top:20px;">Participants</h3>

    ${
      participants.length
        ? `
          <div class="balance-detail-list">
            ${participants.map(participant => `
              <div class="balance-detail-row">
                <div>
                  <div class="user-name">
                    ${escapeHtml(participant.displayName || "Unknown")}
                  </div>
                </div>

                <strong>
                  ${formatMoney(participant.shareAmount)}
                </strong>
              </div>
            `).join("")}
          </div>
        `
        : `
          <div class="card empty">
            No participants found.
          </div>
        `
    }

  `);

  if (expense.receiptFileUrl) {
    const viewReceiptButton = $("#viewExpenseReceiptButton");

    if (viewReceiptButton) {
      viewReceiptButton.addEventListener("click", async () => {
        try {
          setLoading(true, "Opening receipt...");

          const receiptUrl = await getExpenseReceiptUrl(
            expense.receiptFileUrl
          );

          if (!receiptUrl) {
            throw new Error("Unable to open the receipt.");
          }

          window.open(receiptUrl, "_blank", "noopener,noreferrer");
        } catch (error) {
          toast(error.message || "Unable to open the receipt.");
        } finally {
          setLoading(false);
        }
      });
    }
  }
}



async function confirmCloseGroup() {
  closeModal();

  const currentGroup = state.currentGroup?.group;

  if (!currentGroup) {
    toast("No group is currently open.");
    return;
  }

  if (String(currentGroup.status).toUpperCase() !== "ACTIVE") {
    toast("This group is already closed.");
    return;
  }

  const settlements = state.currentGroup.settlements || [];
  const outstandingAmount = settlements.reduce(
    (sum, settlement) => sum + Number(settlement.amount || 0),
    0
  );

  if (outstandingAmount > 0.009) {
    toast(
      `This group still has ${formatMoney(outstandingAmount)} outstanding.`
    );
    return;
  }

  setLoading(true, "Closing group...");

  try {
    const {
      data: { user },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error("Please log in first.");
    }

    const { error: updateError } = await supabaseClient
      .from("groups")
      .update({ status: "CLOSED" })
      .eq("id", currentGroup.groupId);

    if (updateError) {
      throw new Error(
        updateError.message || "Unable to close the group."
      );
    }

    currentGroup.status = "CLOSED";

    toast("Group closed and moved to History.");

    state.groupsLoadedAt = 0;
    await loadGroups();
  } catch (error) {
    console.error("CLOSE GROUP ERROR:", error);
    toast(error.message || "Unable to close the group.");
  } finally {
    setLoading(false);
  }
}


async function deleteClosedGroup(groupId) {

  const group =
    (state.groups || []).find(
      item => String(item.groupId) === String(groupId)
    );

  let groupName =
    group?.groupName || "this group";

  openModal(`
    <div class="close-group-confirmation">

      <div class="close-group-confirmation-icon">
        !
      </div>

      <h2>Delete this group?</h2>

      <p class="close-group-confirmation-group">
        ${escapeHtml(groupName)}
      </p>

      <p class="close-group-confirmation-text">
        This will permanently delete the group and its expenses,
        payments, settlements, and member records.
        This action cannot be undone.
      </p>

      <div class="close-group-confirmation-actions">

        <button
          type="button"
          class="close-group-cancel-button"
          onclick="closeModal()"
        >
          Cancel
        </button>

        <button
          type="button"
          class="close-group-confirm-button"
          onclick="confirmDeleteClosedGroup('${escapeHtml(groupId)}')"
        >
          Delete
        </button>

      </div>

    </div>
  `);
}


async function confirmDeleteClosedGroup(groupId) {

  closeModal();

  setLoading(true, "Deleting group...");

  try {

    const {
      data: { user },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error("Please log in first.");
    }

    const {
      data: group,
      error: groupError
    } = await supabaseClient
      .from("groups")
      .select("id, group_name, created_by, status")
      .eq("id", groupId)
      .single();

    if (groupError || !group) {
      throw new Error("Group not found.");
    }

    if (
      String(group.status).toUpperCase() !==
      "CLOSED"
    ) {
      throw new Error(
        "Only closed groups can be deleted."
      );
    }

    if (
      String(group.created_by) !==
      String(user.id)
    ) {
      throw new Error(
        "Only the group creator can delete this group."
      );
    }

    const { error: deleteError } =
      await supabaseClient
        .from("groups")
        .delete()
        .eq("id", groupId)
        .eq("created_by", user.id)
        .eq("status", "CLOSED");

    if (deleteError) {
      throw new Error(
        deleteError.message ||
        "Unable to delete the group."
      );
    }

    toast("Group deleted.");

    await loadHistory();

  } catch (error) {

    console.error(
      "DELETE GROUP ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to delete the group."
    );

  } finally {

    setLoading(false);

  }
}


async function closeCurrentGroup() {

  const currentGroup =
    state.currentGroup?.group;

  if (!currentGroup) {
    toast("No group is currently open.");
    return;
  }

  if (String(currentGroup.status).toUpperCase() !== "ACTIVE") {
    toast("This group is already closed.");
    return;
  }

  const settlements =
    state.currentGroup.settlements || [];

  const outstandingAmount =
    settlements.reduce(
      (sum, settlement) =>
        sum + Number(settlement.amount || 0),
      0
    );

  if (outstandingAmount > 0.009) {
    toast(
      `This group still has ${formatMoney(outstandingAmount)} outstanding.`
    );
    return;
  }

  openModal(`
    <div class="close-group-confirmation">

      <h2>Close this group?</h2>

      <p class="close-group-confirmation-group">
        ${escapeHtml(currentGroup.groupName)}
      </p>

      <p class="close-group-confirmation-text">
        Everyone is settled. This group will be moved to History
        and will no longer accept new expenses or payments.
      </p>

      <div class="close-group-confirmation-actions">
        <button
          type="button"
          class="close-group-cancel-button"
          onclick="closeModal()"
        >
          Cancel
        </button>

        <button
          type="button"
          class="close-group-confirm-button"
          onclick="confirmCloseGroup()"
        >
          Close group
        </button>
      </div>
    </div>
  `);

  return;

  try {

    const {
      data: {
        user
      },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error("Please log in first.");
    }

    if (
      String(currentGroup.createdBy) !==
      String(user.id)
    ) {
      throw new Error(
        "Only the group creator can close this group."
      );
    }

    const {
      error: updateError
    } = await supabaseClient
      .from("groups")
      .update({
        status: "CLOSED"
      })
      .eq("id", currentGroup.groupId)
      .eq("created_by", user.id);

    if (updateError) {
      throw new Error(
        updateError.message ||
        "Unable to close the group."
      );
    }

    currentGroup.status = "CLOSED";

    toast("Group closed and moved to History.");

    state.groupsLoadedAt = 0;

    await loadGroups();

  } catch (error) {

    console.error(
      "CLOSE GROUP ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to close the group."
    );

  } finally {

    setLoading(false);

  }

}


function renderGroup() {

  const group =
    state.currentGroup.group;

  const expenses =
    state.currentGroup.expenses || [];

  const members =
    state.currentGroup.members || [];

  const balances =
    state.currentGroup.balances || [];

  const settlements =
    state.currentGroup.settlements || [];


  $("#pageTitle").textContent =
    group.groupName;


  const totalSpent =
    expenses.reduce(
      (sum, expense) =>
        sum + Number(expense.amount || 0),
      0
    );


  /*
   * Use payment-aware settlements for
   * the main Payables / Receivables cards.
   *
   * `item.amount` is the REMAINING amount.
   */
  const myPayables =
    settlements
      .filter(item =>
        String(item.fromUserId) ===
        String(state.user.userId)
      )
      .reduce(
        (sum, item) =>
          sum + Number(item.amount || 0),
        0
      );


  const myReceivables =
    settlements
      .filter(item =>
        String(item.toUserId) ===
        String(state.user.userId)
      )
      .reduce(
        (sum, item) =>
          sum + Number(item.amount || 0),
        0
      );


  const payableCount =
    settlements.filter(item =>
      String(item.fromUserId) ===
      String(state.user.userId) &&
      Number(item.amount || 0) > 0.009
    ).length;


  const receivableCount =
    settlements.filter(item =>
      String(item.toUserId) ===
      String(state.user.userId) &&
      Number(item.amount || 0) > 0.009
    ).length;


  $("#content").innerHTML = `

    <div class="group-header">

      <h2>
        ${escapeHtml(group.groupName)}
      </h2>

      <p>
        ${members.length}
        member${members.length === 1 ? "" : "s"}
        · ${formatMoney(totalSpent)} spent
      </p>

    </div>


    ${
      String(group.status).toUpperCase() === "ACTIVE"
        ? `
          <div class="group-top-actions">

            <button
              class="add-expense-button"
              onclick="openAddExpenseModal()"
            >
              + Add Expense
            </button>

            <button
              type="button"
              class="group-icon-action share-group-button"
              onclick="shareCurrentGroup()"
              aria-label="Share group"
              title="Share group"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle cx="18" cy="5" r="2.5"></circle>
                <circle cx="6" cy="12" r="2.5"></circle>
                <circle cx="18" cy="19" r="2.5"></circle>
                <path d="M8.2 10.8l7.5-4.4"></path>
                <path d="M8.2 13.2l7.5 4.4"></path>
              </svg>
            </button>

            <button
              type="button"
              class="group-icon-action members-button"
              onclick="openMembersModal()"
              aria-label="Add Members"
              title="Add Members"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle cx="9" cy="8" r="3"></circle>
                <path d="M3.5 19c.7-3.2 2.6-5 5.5-5s4.8 1.8 5.5 5"></path>
                <path d="M16 7.5c2.2.2 3.5 1.8 3.5 4"></path>
                <path d="M16.5 14c2.5.3 4 2 4.5 5"></path>
              </svg>
            </button>

            <button
              type="button"
              class="group-icon-action close-group-button"
              onclick="closeCurrentGroup()"
              aria-label="Close group"
              title="Close group"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle cx="9" cy="8" r="3"></circle>
                <path d="M3.5 19c.7-3.2 2.6-5 5.5-5s4.8 1.8 5.5 5"></path>
                <circle cx="16.5" cy="9" r="2.3"></circle>
                <path d="M14 19c.4-2.3 1.3-3.8 2.8-4.4"></path>
                <path d="M18 14.6c1.5.7 2.3 2 2.6 4.4"></path>
              </svg>
            </button>

          </div>
        `
        : `
          <div class="group-closed-banner">
            ✓ This group is closed. You're viewing its history.
          </div>
        `
    }


    <div class="history-tabs">

      <button
        type="button"
        class="history-tab active"
        data-group-tab="settlements"
        onclick="switchGroupTab(this)"
      >
        Settlements
      </button>

      <button
        type="button"
        class="history-tab"
        data-group-tab="pending"
        onclick="switchGroupTab(this)"
      >
        Pending
      </button>

      <button
        type="button"
        class="history-tab"
        data-group-tab="members"
        onclick="switchGroupTab(this)"
      >
        Members
      </button>

    </div>


    <div
      id="groupTabSettlements"
      class="group-tab-panel"
    >

     


    <div class="balance-sections">

      <div class="balance-section">

        <div>

          <div class="balance-section-title">
            Payables
          </div>

          <div class="muted">
            What I need to pay
          </div>

          <div class="balance-section-amount">
            ${formatMoney(myPayables)}
          </div>

          <div class="muted">
            ${payableCount}
            ${payableCount === 1 ? "person" : "people"}
          </div>

        </div>

        <button
          class="small-button"
          onclick="openPayables()"
        >
          ${
            String(group.status).toUpperCase() === "ACTIVE"
              ? "Settle →"
              : "View history →"
          }
        </button>

      </div>


      <div class="balance-section">

        <div>

          <div class="balance-section-title">
            Receivables
          </div>

          <div class="muted">
            What others need to pay me
          </div>

          <div class="balance-section-amount">
            ${formatMoney(myReceivables)}
          </div>

          <div class="muted">
            ${receivableCount}
            ${receivableCount === 1 ? "person" : "people"}
          </div>

        </div>

        <button
          class="small-button"
          onclick="openReceivables()"
        >
          ${
            String(group.status).toUpperCase() === "ACTIVE"
              ? "Check details →"
              : "View history →"
          }
        </button>

      </div>

    </div>


    <div class="section-title">
      Transactions
    </div>


    <div class="transactions-wrapper">

      <table class="transactions-table">

        <thead>

          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Description</th>
            <th>From</th>
            <th>To</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Action</th>
          </tr>

        </thead>

        <tbody id="transactionsTableBody">

          <tr>

            <td
              colspan="8"
              class="muted transactions-loading"
            >
              Loading transactions...
            </td>

          </tr>

        </tbody>

      </table>

    </div>


    </div>


    <div
      id="groupTabPending"
      class="group-tab-panel"
      hidden
    >

      <div class="section-title">
        Pending Payments to Settle
      </div>

      <div
        id="pendingPayablesList"
        class="pending-list-container"
      >

        <div class="muted">
          Loading payments to settle...
        </div>

      </div>

      <div class="section-title pending-section-title">
        Pending Payment Reviews
      </div>

      <div
        id="pendingPaymentsList"
        class="pending-list-container"
      >

        <div class="muted">
          Loading pending payments...
        </div>

      </div>

    </div>


    <div
      id="groupTabMembers"
      class="group-tab-panel"
      hidden
    >

      <div class="section-title">
        Members
      </div>

      <div class="group-members-list">

        ${
          members.length
            ? `
              <div class="group-member-list-header">
                <span>Name</span>
                <span>Spend</span>
                <span>Payables</span>
                <span>Receivables</span>
                <span>Role</span>
              </div>

              ${members.map(member => {

                const memberBalance =
                  balances.find(
                    balance =>
                      String(balance.userId) ===
                      String(member.userId)
                  ) || {};

                const spend =
                  Number(memberBalance.totalPaid || 0);

                /*
                 * Use the same payment-aware, reciprocal-netted
                 * settlements as the main Payables / Receivables
                 * cards.
                 *
                 * This prevents unrelated settlements between
                 * other members from appearing as this member's
                 * payable or receivable.
                 */
                const memberPayables =
                  settlements
                    .filter(item =>
                      String(item.fromUserId) ===
                      String(member.userId)
                    )
                    .reduce(
                      (sum, item) =>
                        sum + Number(item.amount || 0),
                      0
                    );

                const memberReceivables =
                  settlements
                    .filter(item =>
                      String(item.toUserId) ===
                      String(member.userId)
                    )
                    .reduce(
                      (sum, item) =>
                        sum + Number(item.amount || 0),
                      0
                    );

                const payables =
                  Number(
                    memberPayables.toFixed(2)
                  );

                const receivables =
                  Number(
                    memberReceivables.toFixed(2)
                  );

                const role =
                  String(member.role || "").toUpperCase();

                return `
                  <div class="group-member-list-item">

                    <div class="group-member-list-name">
                      ${escapeHtml(member.displayName || "Member")}
                    </div>

                    <div class="group-member-list-stat">
                      ${formatMoney(spend)}
                    </div>

                    <div class="group-member-list-stat">
                      ${formatMoney(payables)}
                    </div>

                    <div class="group-member-list-stat">
                      ${formatMoney(receivables)}
                    </div>

                    <div class="group-member-list-role">
                      ${
                        role === "ADMIN"
                          ? "Admin"
                          : role === "MEMBER"
                            ? "Member"
                            : escapeHtml(String(member.role || ""))
                      }
                    </div>

                  </div>
                `;

              }).join("")}
            `
            : `
              <div class="muted">
                No members found.
              </div>
            `
        }

      </div>

    </div>


  `;


  loadGroupTransactions();

}


function renderExpense(expense) {

  const participantText =
    expense.participants.length === 1
      ? `For ${escapeHtml(expense.participants[0].displayName || "Member")}`
      : `${expense.participants.length} participants`;

  return `

    <div
      class="expense-card"
      data-expense-id="${escapeHtml(expense.expenseId)}"
    >

      <div class="expense-top">

        <div class="expense-payer">
          ${escapeHtml(expense.paidBy.displayName || "Unknown")}
        </div>

        <div class="expense-amount">
          ${formatMoney(expense.amount)}
        </div>

      </div>

      ${
        expense.description
        ? `
          <div class="expense-description">
            ${escapeHtml(expense.description)}
          </div>
        `
        : ""
      }

      <div class="expense-meta">
        ${participantText} · ${formatDate(expense.createdAt)}
      </div>

    </div>
  `;
}


function bindExpenseCards() {

  document.querySelectorAll(".expense-card").forEach(card => {

    card.addEventListener("click", () => {
      openExpenseDetails(card.dataset.expenseId);
    });

  });

}


/* =========================================================
   CREATE GROUP
   ========================================================= */

async function openCreateGroupModal() {

  openModal(`

    <h2>Create Group</h2>

    <form id="createGroupForm">

      <label>
        Group name

        <input
          id="newGroupName"
          maxlength="80"
          required
          placeholder="Boracay Trip"
        >
      </label>

      <div class="section-title">
        Add members
      </div>

      <div class="contacts-search create-group-member-search">

        <input
          type="search"
          id="newGroupMemberSearch"
          placeholder="Search OweMe users by username..."
          autocomplete="off"
        >

      </div>

      <div
        id="newGroupMemberSuggestions"
        class="invite-contact-suggestions"
      ></div>

      <div class="selected-members-title">
        Selected members
      </div>

      <div
        id="newGroupSelectedMembers"
        class="selected-members-list"
      ></div>

      <textarea
        id="newGroupMembers"
        hidden
      ></textarea>

      <small class="field-help">
        Search any active OweMe user. They do not need to be in your Contacts.
      </small>

      <button
        class="primary-button"
        type="submit"
      >
        Create Group
      </button>

    </form>

  `);

  const searchInput =
    $("#newGroupMemberSearch");

  const suggestions =
    $("#newGroupMemberSuggestions");

  const selectedList =
    $("#newGroupSelectedMembers");

  const hiddenMembers =
    $("#newGroupMembers");

  const selectedMembers = [];

  let users = [];

  try {

    const {
      data: profiles,
      error
    } = await supabaseClient
      .from("profiles")
      .select(
        "id, username, username_normalized, display_name, status"
      )
      .neq(
        "id",
        String(state.user.userId)
      )
      .eq(
        "status",
        "ACTIVE"
      )
      .order(
        "username_normalized",
        {
          ascending: true
        }
      );

    if (error) {
      throw error;
    }

    users =
      (profiles || [])
        .filter(profile =>
          profile.username
        )
        .map(profile => ({
          userId:
            String(profile.id),

          username:
            profile.username,

          displayName:
            profile.display_name || ""
        }));


  } catch (error) {

    console.error(
      "LOAD CREATE GROUP USERS ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to load OweMe users."
    );

  }

  function syncSelectedMembers() {

    hiddenMembers.value =
      selectedMembers
        .map(member => member.username)
        .join("\n");

  }

  function renderSelectedMembers() {

    if (!selectedMembers.length) {

      selectedList.innerHTML = `
        <div class="selected-members-empty">
          No members selected yet.
        </div>
      `;

      syncSelectedMembers();

      return;
    }

    selectedList.innerHTML =
      selectedMembers.map(member => `

        <div
          class="selected-member-row"
          data-selected-user-id="${escapeHtml(String(member.userId))}"
        >

          <div>

            <div class="user-name">
              ${escapeHtml(member.displayName || "Member")}
            </div>

          </div>

          <button
            type="button"
            class="selected-member-remove"
            data-remove-user-id="${escapeHtml(String(member.userId))}"
            aria-label="Remove ${escapeHtml(member.username)}"
          >
            ×
          </button>

        </div>

      `).join("");

    selectedList
      .querySelectorAll(".selected-member-remove")
      .forEach(button => {

        button.addEventListener("click", () => {

          const userId =
            String(
              button.dataset.removeUserId || ""
            );

          const index =
            selectedMembers.findIndex(
              member =>
                String(member.userId) === userId
            );

          if (index !== -1) {
            selectedMembers.splice(index, 1);
          }

          renderSelectedMembers();
          renderUserSuggestions(searchInput.value);

        });

      });

    syncSelectedMembers();

  }

  function addSelectedMember(user) {

    const userId =
      String(user.userId);

    const username =
      String(user.username || "")
        .trim()
        .replace(/^@/, "");

    if (!userId || !username) {
      return;
    }

    const alreadySelected =
      selectedMembers.some(
        selected =>
          String(selected.userId) === userId ||
          String(selected.username).toLowerCase() ===
            username.toLowerCase()
      );

    if (alreadySelected) {
      toast("That member is already selected.");
      return;
    }

    selectedMembers.push({
      userId,
      username,
      displayName:
        user.displayName || ""
    });

    searchInput.value = "";
    suggestions.innerHTML = "";

    renderSelectedMembers();

    searchInput.focus();

  }

  function renderUserSuggestions(query = "") {

    const normalizedQuery =
      String(query || "")
        .trim()
        .replace(/^@/, "")
        .toLowerCase();

    if (!normalizedQuery) {
      suggestions.innerHTML = "";
      return;
    }

    const selectedUserIds =
      new Set(
        selectedMembers.map(member =>
          String(member.userId)
        )
      );

    const selectedUsernames =
      new Set(
        selectedMembers.map(member =>
          String(member.username).toLowerCase()
        )
      );

    const filtered =
      users.filter(user => {

        const userId =
          String(user.userId);

        const username =
          String(user.username || "")
            .toLowerCase();

        const displayName =
          String(user.displayName || "")
            .toLowerCase();

        if (
          selectedUserIds.has(userId) ||
          selectedUsernames.has(username)
        ) {
          return false;
        }

        return (
          username.includes(normalizedQuery) ||
          displayName.includes(normalizedQuery)
        );

      });

    suggestions.innerHTML =
      filtered.length
        ? filtered.map(user => `

            <button
              type="button"
              class="invite-contact-suggestion"
              data-user-id="${escapeHtml(String(user.userId))}"
            >

              <span>

                <strong>
                  ${escapeHtml(user.displayName || "Member")}
                </strong>

              </span>

              <small class="muted">
                @${escapeHtml(user.username)}
              </small>

            </button>

          `).join("")
        : `
            <div class="invite-contact-empty">
              No OweMe user found.
            </div>
          `;

    suggestions
      .querySelectorAll(".invite-contact-suggestion")
      .forEach(button => {

        button.addEventListener("click", () => {

          const userId =
            String(
              button.dataset.userId || ""
            );

          const user =
            users.find(
              item =>
                String(item.userId) === userId
            );

          if (user) {
            addSelectedMember(user);
          }

        });

      });

  }

  searchInput.addEventListener("input", event => {

    renderUserSuggestions(
      event.target.value
    );

  });

  searchInput.addEventListener("keydown", event => {

    if (
      event.key === "Enter" &&
      String(searchInput.value || "").trim()
    ) {

      event.preventDefault();

      const query =
        String(searchInput.value || "")
          .trim()
          .replace(/^@/, "")
          .toLowerCase();

      const exactUser =
        users.find(user =>
          String(user.username || "")
            .toLowerCase() === query
        );

      if (exactUser) {

        addSelectedMember(exactUser);

      } else {

        toast(
          "No OweMe user found with that username."
        );

      }

    }

  });

  renderSelectedMembers();

  $("#createGroupForm").addEventListener(
    "submit",
    createGroup
  );

}

async function createGroup(event) {

  event.preventDefault();

  const groupName =
    $("#newGroupName").value.trim();

  const usernames =
    $("#newGroupMembers")
      .value
      .split("\n")
      .map(username =>
        username.trim().replace(/^@/, "")
      )
      .filter(Boolean);

  if (!groupName) {
    toast("Please enter a group name.");
    return;
  }

  if (!usernames.length) {
    toast("Please select at least one member.");
    return;
  }

  try {

    setLoading(true, "Creating group...");

    /* ================================================
       1. GET CURRENT SUPABASE USER
       ================================================ */

    const {
      data: {
        user
      },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error(
        "Your session has expired. Please log in again."
      );
    }

    /* ================================================
       2. RESOLVE SELECTED USERS BEFORE CREATING GROUP
       ================================================ */

    const normalizedUsernames =
      [...new Set(
        usernames
          .map(username =>
            username.toLowerCase()
          )
          .filter(Boolean)
      )];

    const {
      data: invitedProfiles,
      error: profileError
    } = await supabaseClient
      .from("profiles")
      .select(
        "id, username, username_normalized, display_name, status"
      )
      .in(
        "username_normalized",
        normalizedUsernames
      );

    if (profileError) {
      throw new Error(
        profileError.message ||
        "Unable to find the selected OweMe users."
      );
    }

    const profiles =
      (invitedProfiles || [])
        .filter(profile =>
          profile.status === "ACTIVE"
        );

    const foundUsernames =
      new Set(
        profiles.map(profile =>
          String(profile.username_normalized || "")
            .toLowerCase()
        )
      );

    const missingUsernames =
      normalizedUsernames.filter(
        username =>
          !foundUsernames.has(username)
      );

    if (missingUsernames.length) {

      throw new Error(
        `These users don't have active OweMe accounts: ${missingUsernames
          .map(username => "@" + username)
          .join(", ")}`
      );

    }

    /* ================================================
       3. DO NOT INVITE YOURSELF
       ================================================ */

    const validProfiles =
      profiles.filter(
        profile =>
          String(profile.id) !== String(user.id)
      );

    if (!validProfiles.length) {
      throw new Error(
        "Please select at least one other OweMe user."
      );
    }

    /* ================================================
       4. CREATE GROUP
       ================================================ */

    const {
      data: group,
      error: groupError
    } = await supabaseClient
      .rpc("create_group", {
        p_group_name: groupName
      });

    if (groupError) {
      throw new Error(
        groupError.message ||
        "Unable to create the group."
      );
    }

    if (!group) {
      throw new Error(
        "Group creation did not return a group."
      );
    }

    /* ================================================
       5. ADD CREATOR AS ADMIN
       ================================================ */

    const {
      error: memberError
    } = await supabaseClient
      .from("group_members")
      .insert({
        group_id: group.id,
        user_id: user.id,
        role: "ADMIN",
        status: "ACTIVE"
      });

    if (memberError) {

      console.error(
        "CREATE GROUP MEMBERSHIP ERROR:",
        memberError
      );

      throw new Error(
        memberError.message ||
        "The group was created, but you could not be added as its admin."
      );

    }

    /* ================================================
       6. CREATE PENDING INVITATIONS
       ================================================ */

    const invitations = [];

    for (const profile of validProfiles) {

      /*
       * Check whether the user is already an
       * active member of this group.
       */

      const {
        data: existingMember,
        error: existingMemberError
      } = await supabaseClient
        .from("group_members")
        .select("user_id")
        .eq("group_id", group.id)
        .eq("user_id", profile.id)
        .eq("status", "ACTIVE")
        .maybeSingle();

      if (existingMemberError) {
        throw new Error(
          existingMemberError.message
        );
      }

      if (existingMember) {
        continue;
      }

      /*
       * Check for an existing pending invitation.
       */

      const {
        data: existingInvitation,
        error: existingInvitationError
      } = await supabaseClient
        .from("invitations")
        .select("id")
        .eq("group_id", group.id)
        .eq("invited_user_id", profile.id)
        .eq("status", "PENDING")
        .maybeSingle();

      if (existingInvitationError) {
        throw new Error(
          existingInvitationError.message
        );
      }

      if (existingInvitation) {
        continue;
      }

      invitations.push({
        group_id: group.id,
        invited_user_id: profile.id,
        invited_by_user_id: user.id,
        status: "PENDING"
      });

    }

    if (!invitations.length) {

      throw new Error(
        "No new invitations could be created for the selected users."
      );

    }

    const {
      error: invitationError
    } = await supabaseClient
      .from("invitations")
      .insert(invitations);

    if (invitationError) {
      throw new Error(
        invitationError.message ||
        "The group was created, but the invitations could not be sent."
      );
    }

    /* ================================================
       7. REFRESH GROUP STATE
       ================================================ */

    state.groupsLoadedAt = 0;

    closeModal();

    toast(
      invitations.length === 1
        ? "Group created and invitation sent."
        : `Group created and ${invitations.length} invitations sent.`
    );

    await loadGroupsData(true);

    await openGroup(group.id);

  } catch (error) {

    console.error(
      "CREATE GROUP ERROR:",
      error
    );

    toast(
      error && error.message
        ? error.message
        : "Unable to create group."
    );

  } finally {

    setLoading(false);

  }

}

/* =========================================================
   ADD EXPENSE
   ========================================================= */

async function shareCurrentGroup() {

  try {

    const group =
      state.currentGroup?.group;

    if (!group) {
      toast("No group is currently open.");
      return;
    }

    const groupId =
      group.groupId;

    const groupName =
      group.groupName || "OweMe group";

    if (!groupId) {
      throw new Error("Group ID not found.");
    }

    const shareUrl =
      new URL(
        `?group=${encodeURIComponent(groupId)}`,
        window.location.origin +
          window.location.pathname
      ).href;

    await navigator.clipboard.writeText(shareUrl);

    toast("Group link copied!");

  } catch (error) {

    console.error(
      "SHARE GROUP ERROR:",
      error
    );

    toast(
      error?.message ||
      "Unable to create group link."
    );

  }

}


function openAddExpenseModal() {

  const members = state.currentGroup.members || [];

  openModal(`

    <h2>Add Expense</h2>

    <form id="addExpenseForm">

      <label>
        Amount
        <input
          id="expenseAmount"
          class="amount-input"
          type="number"
          min="0.01"
          step="0.01"
          inputmode="decimal"
          placeholder="0.00"
          required
        >
      </label>

      <label>
        Description
        <input
          id="expenseDescription"
          maxlength="120"
          placeholder="Dinner"
        >
      </label>

      <div class="expense-participants-section">

        <div class="section-title">
          Paid by
        </div>

        <div class="expense-paid-by">
          <strong>${escapeHtml(state.user.displayName || "Member")}</strong>
          <div class="muted">
            You are paying for this expense.
          </div>
        </div>

        <div class="section-title">
          <div>
            <strong>Who should share this?</strong>
            <div class="muted" style="font-size:12px;margin-top:3px">
              Select only the members included in this expense.
            </div>
          </div>
        </div>

        <div class="participant-list">

          ${members.map(member => `
            <label class="participant-option">

              <input
                type="checkbox"
                class="participant-checkbox"
                value="${escapeHtml(member.userId)}"
                checked
              >

              <div class="participant-display-name">
                ${escapeHtml(member.displayName || "Member")}
              </div>

            </label>
          `).join("")}

        </div>

      </div>

      <div class="expense-split-section">

        <div class="section-title">
          <div>
            <strong>How should it be split?</strong>
            <div class="muted" style="font-size:12px;margin-top:3px">
              Choose equal shares or set a custom amount for each member.
            </div>
          </div>
        </div>

        <div class="split-mode-toggle">
          <button
            type="button"
            class="split-mode-button active"
            data-split-mode="EQUAL"
          >Equal</button>

          <button
            type="button"
            class="split-mode-button"
            data-split-mode="CUSTOM"
          >Custom</button>
        </div>

        <input type="hidden" id="expenseSplitMode" value="EQUAL">

        <div id="expenseSplitEditor"></div>

        <div id="expenseSplitSummary" class="expense-split-summary">
          <div>
            <span>Assigned</span>
            <strong id="expenseAssignedAmount">₱0.00</strong>
          </div>
          <div>
            <span>Remaining</span>
            <strong id="expenseRemainingAmount">₱0.00</strong>
          </div>
        </div>

      </div>

      <div class="expense-receipt-section">
        <div class="section-title">
          <div>
            <strong>Receipt</strong>
            <div class="muted" style="font-size:12px;margin-top:3px">
              Optional. Attach a photo or PDF of the receipt.
            </div>
          </div>
        </div>
        <label class="receipt-upload-box" for="expenseReceipt">
          <span class="receipt-upload-icon">📎</span>
          <span id="expenseReceiptLabel">Upload receipt</span>
          <input id="expenseReceipt" type="file" accept="image/*,application/pdf" hidden>
        </label>
      </div>

      <button
        class="primary-button"
        type="submit"
        style="margin-top:18px"
      >
        Add Expense
      </button>

    </form>

  `);

  const form = $("#addExpenseForm");
  const amountInput = $("#expenseAmount");
  const splitModeInput = $("#expenseSplitMode");

  form.addEventListener("submit", addExpense);

  function getSelectedMembers() {
    return [...document.querySelectorAll(".participant-checkbox:checked")]
      .map(input =>
        members.find(
          member => String(member.userId) === String(input.value)
        )
      )
      .filter(Boolean);
  }

  function getExistingCustomValues() {
    const values = {};

    document.querySelectorAll(".custom-share-input").forEach(input => {
      values[input.dataset.userId] = input.value;
    });

    return values;
  }

  function renderSplitEditor(existingValues = {}) {

    const selectedMembers = getSelectedMembers();
    const editor = $("#expenseSplitEditor");

    if (!selectedMembers.length) {
      editor.innerHTML = `
        <div class="expense-empty-state">
          Select at least one member to continue.
        </div>
      `;

      updateExpenseSplitSummary();
      return;
    }

    const amount = Number(amountInput.value || 0);
    const amountCents = Math.round(amount * 100);
    const count = selectedMembers.length;

    const base =
      count
        ? Math.floor(amountCents / count)
        : 0;

    const remainder =
      count
        ? amountCents % count
        : 0;

    const isCustom =
      splitModeInput.value === "CUSTOM";

    editor.innerHTML =
      selectedMembers.map((member, index) => {

        const equalShare =
          (base + (index < remainder ? 1 : 0)) / 100;

        const previous =
          existingValues[String(member.userId)];

        const value =
          isCustom
            ? (
                previous !== undefined
                  ? previous
                  : "0.00"
              )
            : equalShare.toFixed(2);

        return `
          <div class="expense-share-row">

            <div>
              <div class="user-name">
                ${escapeHtml(member.displayName || "Member")}
              </div>

            </div>

            <div class="expense-share-input-wrap">
              <span>₱</span>

              <input
                class="custom-share-input"
                data-user-id="${escapeHtml(member.userId)}"
                type="number"
                min="0"
                step="0.01"
                inputmode="decimal"
                value="${value}"
                ${isCustom ? "" : "readonly"}
              >
            </div>

          </div>
        `;

      }).join("");

    updateExpenseSplitSummary();
  }

  function updateExpenseSplitSummary() {

    const inputs =
      [...document.querySelectorAll(".custom-share-input")];

    const assigned =
      inputs.reduce((sum, input) => {

        const value =
          Number(input.value || 0);

        return sum +
          (
            Number.isFinite(value)
              ? value
              : 0
          );

      }, 0);

    const total =
      Number(amountInput.value || 0);

    const remaining =
      Math.round(
        (total - assigned) * 100
      ) / 100;

    const assignedEl =
      $("#expenseAssignedAmount");

    const remainingEl =
      $("#expenseRemainingAmount");

    const summary =
      $("#expenseSplitSummary");

    if (!assignedEl || !remainingEl || !summary) {
      return;
    }

    assignedEl.textContent =
      formatMoney(assigned);

    remainingEl.textContent =
      formatMoney(
        Math.abs(remaining) < 0.005
          ? 0
          : remaining
      );

    const valid =
      Math.abs(remaining) < 0.005 &&
      total > 0 &&
      inputs.length > 0;

    summary.classList.toggle(
      "valid",
      valid
    );

    summary.classList.toggle(
      "invalid",
      !valid
    );

    const submitButton =
      form.querySelector(
        'button[type="submit"]'
      );

    if (submitButton) {
      submitButton.disabled =
        !getSelectedMembers().length ||
        total <= 0 ||
        Math.abs(remaining) >= 0.005;
    }
  }

  document
    .querySelectorAll(".split-mode-button")
    .forEach(button => {

      button.addEventListener(
        "click",
        () => {

          const targetMode =
            button.dataset.splitMode;

          const previousValues =
            targetMode === "CUSTOM"
              ? {}
              : getExistingCustomValues();

          splitModeInput.value =
            targetMode;

          document
            .querySelectorAll(".split-mode-button")
            .forEach(item => {

              item.classList.toggle(
                "active",
                item.dataset.splitMode ===
                  splitModeInput.value
              );

            });

          renderSplitEditor(
            previousValues
          );

        }
      );

    });

  document
    .querySelectorAll(".participant-checkbox")
    .forEach(input => {

      input.addEventListener(
        "change",
        () => {

          const previousValues =
            getExistingCustomValues();

          renderSplitEditor(
            previousValues
          );

        }
      );

    });

  amountInput.addEventListener(
    "input",
    () => {

      const previousValues =
        getExistingCustomValues();

      renderSplitEditor(
        previousValues
      );

    }
  );

  form.addEventListener(
    "input",
    event => {

      if (
        event.target.classList.contains(
          "custom-share-input"
        )
      ) {
        updateExpenseSplitSummary();
      }

    }
  );

  const receiptInput = $("#expenseReceipt");
  const receiptLabel = $("#expenseReceiptLabel");

  if (receiptInput && receiptLabel) {
    receiptInput.addEventListener("change", () => {
      const file = receiptInput.files?.[0];
      if (!file) {
        receiptLabel.textContent = "Upload receipt";
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        receiptInput.value = "";
        receiptLabel.textContent = "Upload receipt";
        toast("Receipt must be 10 MB or smaller.");
        return;
      }
      receiptLabel.textContent = file.name;
    });
  }

  renderSplitEditor();
}


async function uploadExpenseReceiptToSupabase(file, groupId, expenseId) {
  if (!file) return "";

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/pdf"
  ];

  if (!allowedTypes.includes(file.type)) {
    throw new Error("Receipt must be an image or PDF.");
  }

  if (file.size > 10 * 1024 * 1024) {
    throw new Error("Receipt must be 10 MB or smaller.");
  }

  const extensionMap = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf"
  };

  const extension = extensionMap[file.type] || "bin";
  const filePath = groupId + "/" + expenseId + "/" + crypto.randomUUID() + "." + extension;

  const { error } = await supabaseClient.storage
    .from("expense-receipts")
    .upload(filePath, file, {
      contentType: file.type,
      upsert: false
    });

  if (error) {
    throw new Error(error.message || "Unable to upload receipt.");
  }

  return filePath;
}


async function getExpenseReceiptUrl(storagePath) {
  if (!storagePath) return "";

  const { data, error } = await supabaseClient.storage
    .from("expense-receipts")
    .createSignedUrl(storagePath, 3600);

  if (error) {
    console.error("EXPENSE RECEIPT URL ERROR:", error);
    return "";
  }

  return data?.signedUrl || "";
}


async function addExpense(event) {

  event.preventDefault();

  const amount =
    Number($("#expenseAmount").value);

  const description =
    $("#expenseDescription").value.trim();

  const receiptInput = $("#expenseReceipt");
  const receiptFile =
    receiptInput?.files?.length
      ? receiptInput.files[0]
      : null;

  const participantIds =
    [...document.querySelectorAll(".participant-checkbox:checked")]
      .map(input => input.value);

  if (!Number.isFinite(amount) || amount <= 0) {
    toast("Enter a valid amount.");
    return;
  }

  if (amount > 100000000) {
    toast("Amount is too large.");
    return;
  }

  if (!participantIds.length) {
    toast("Select at least one participant.");
    return;
  }

  try {

    setLoading(true, "Adding expense...");

    const {
      data: {
        user
      },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error(
        "Your session has expired. Please log in again."
      );
    }

    const groupId =
      state.currentGroup.group.groupId;

    const uniqueParticipantIds =
      [...new Set(participantIds)];

    const {
      data: members,
      error: memberError
    } = await supabaseClient
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("status", "ACTIVE")
      .in("user_id", uniqueParticipantIds);

    if (memberError) {
      throw new Error(
        memberError.message ||
        "Unable to verify expense participants."
      );
    }

    const activeMemberIds =
      new Set(
        (members || [])
          .map(member => member.user_id)
      );

    const allParticipantsAreMembers =
      uniqueParticipantIds.every(
        id => activeMemberIds.has(id)
      );

    if (!allParticipantsAreMembers) {
      throw new Error(
        "All participants must be active members of this group."
      );
    }

    const shareInputs =
      [...document.querySelectorAll(".custom-share-input")];

    const shares =
      uniqueParticipantIds.map(userId => {

        const input =
          shareInputs.find(
            item =>
              String(item.dataset.userId) ===
              String(userId)
          );

        const shareAmount =
          Number(input?.value || 0);

        if (
          !Number.isFinite(shareAmount) ||
          shareAmount < 0
        ) {
          throw new Error(
            "Each participant must have a valid share amount."
          );
        }

        return {
          user_id: userId,
          share_amount:
            Math.round(
              shareAmount * 100
            ) / 100
        };

      });

    const totalShares =
      Math.round(
        shares.reduce(
          (sum, share) =>
            sum + share.share_amount,
          0
        ) * 100
      ) / 100;

    const expenseTotal =
      Number(amount.toFixed(2));

    if (
      Math.abs(
        totalShares - expenseTotal
      ) > 0.005
    ) {
      throw new Error(
        `Participant shares must equal the expense amount. Remaining: ${formatMoney(
          expenseTotal - totalShares
        )}`
      );
    }

    const {
      data: expense,
      error: expenseError
    } = await supabaseClient
      .from("expenses")
      .insert({
        group_id: groupId,
        paid_by_user_id: user.id,
        amount: expenseTotal,
        description,
        created_by: user.id,
        status: "ACTIVE"
      })
      .select()
      .single();

    if (expenseError) {
      throw new Error(
        expenseError.message ||
        "Unable to add the expense."
      );
    }

    let receiptFileUrl = "";

    if (receiptFile) {
      try {
        receiptFileUrl =
          await uploadExpenseReceiptToSupabase(
            receiptFile,
            groupId,
            expense.id
          );

        const { error: receiptSaveError } =
          await supabaseClient
            .from("expenses")
            .update({
              receipt_file_url: receiptFileUrl
            })
            .eq("id", expense.id);

        if (receiptSaveError) {
          throw receiptSaveError;
        }
      } catch (receiptError) {
        await supabaseClient
          .from("expenses")
          .delete()
          .eq("id", expense.id);

        throw new Error(
          receiptError.message ||
          "The receipt could not be uploaded."
        );
      }
    }

    const participantRows =
      shares.map(share => ({
        expense_id: expense.id,
        user_id: share.user_id,
        share_amount: share.share_amount
      }));

    const {
      error: participantError
    } = await supabaseClient
      .from("expense_participants")
      .insert(participantRows);

    if (participantError) {

      console.error(
        "ADD EXPENSE PARTICIPANTS ERROR:",
        participantError
      );

      await supabaseClient
        .from("expenses")
        .delete()
        .eq("id", expense.id);

      throw new Error(
        participantError.message ||
        "The expense could not be saved."
      );
    }

    closeModal();

    await refreshCurrentGroup();

    toast("Expense added.");

  } catch (error) {

    console.error(
      "ADD EXPENSE ERROR:",
      error
    );

    toast(
      error && error.message
        ? error.message
        : "Unable to add expense."
    );

  } finally {

    setLoading(false);

  }
}


async function deleteExpense(expenseId) {

  openModal(`
    <h2>Delete Expense</h2>

    <p class="muted">
      Are you sure you want to delete this expense?
    </p>

    <div
      class="close-group-confirmation-actions"
      style="margin-top:20px;"
    >
      <button
        type="button"
        class="secondary-button"
        onclick="closeModal()"
      >
        Cancel
      </button>

      <button
        type="button"
        class="danger-button"
        onclick="confirmDeleteExpense('${escapeHtml(expenseId)}')"
      >
        Delete
      </button>
    </div>
  `);
}


async function confirmDeleteExpense(expenseId) {

  try {

    setLoading(true, "Deleting expense...");

    const { error } = await supabaseClient
      .from("expenses")
      .update({ status: "DELETED" })
      .eq("id", expenseId)
      .eq("created_by", state.user.userId);

    if (error) {
      throw error;
    }

    closeModal();

    await refreshCurrentGroup();

    toast("Expense deleted.");

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }
}


/* =========================================================
   BALANCES
   ========================================================= */

async function openBalancesModal() {

  setLoading(true, "Loading balances...");

  try {

    const result = await getBalancesFromSupabase(
      state.currentGroup.group.groupId
    );

    const balances = result.data.balances;

    openModal(`

      <h2>Balances</h2>

      <p class="muted">
        Paid minus fair share.
      </p>

      <div class="card">

        ${balances.map(item => `

          <div class="member-row">

            <div>
              <div class="user-name">
                ${escapeHtml(item.displayName || "Unknown")}
              </div>

              <div class="user-handle">
                Paid ${formatMoney(item.totalPaid)}
                · Share ${formatMoney(item.totalShare)}
              </div>
            </div>

            <strong class="${balanceClass(item.balance)}">
              ${formatBalance(item.balance)}
            </strong>

          </div>

        `).join("")}

      </div>

    `);

    await loadPendingPayables();
    await loadPendingPayments();

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }
}


/* =========================================================
   SETTLEMENTS
   ========================================================= */

async function loadCurrentSettlements() {

  const result = await getSettlementsFromSupabase(
    state.currentGroup.group.groupId
  );

  return result.settlements ||
    result.data?.settlements ||
    [];

}


async function openPayables() {

  setLoading(true, "Loading payables...");

  try {

    const settlements =
      await loadCurrentSettlements();

    const payables =
      settlements.filter(item =>
        String(item.fromUserId) ===
        String(state.user.userId)
      );

    openModal(`

      <h2>Payables</h2>

      <p class="muted">
        People you still need to pay.
      </p>

      ${
        payables.length
          ? `
            <div class="balance-detail-list">

              ${payables.map(item => `

                <div
                  class="balance-detail-row"
                  style="align-items:center;"
                >

                  <div style="flex:1;">

                    <div class="user-name">
                      ${escapeHtml(item.toDisplayName || item.toUsername || "Unknown")}
                    </div>

                    <div
                      style="
                        font-size:24px;
                        font-weight:700;
                        margin-top:4px;
                      "
                    >
                      ${formatMoney(item.amount)}
                    </div>

                    <div class="muted">
                      You still need to pay
                    </div>

                  </div>

                  <div
                    class="payable-action-buttons"
                    style="
                      display:flex;
                      flex-direction:row;
                      gap:8px;
                      align-items:center;
                      justify-content:flex-end;
                    "
                  >

                    <button
                      type="button"
                      class="small-button"
                      onclick="openPayableDetails('${escapeHtml(item.settlementId)}')"
                    >
                      View details
                    </button>

                    <button
                      type="button"
                      class="small-button settle-payable-button"
                      onclick="openSettlePayment('${escapeHtml(item.settlementId)}')"
                    >
                      Settle
                    </button>

                  </div>

                </div>

              `).join("")}

            </div>
          `
          : `
            <div class="card empty">
              You do not owe anyone right now.
            </div>
          `
      }

    `);

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }

}


async function openPayableDetails(settlementId) {

  setLoading(true, "Loading payable details...");

  try {

    const settlements =
      await loadCurrentSettlements();

    const settlement =
      settlements.find(item =>
        String(item.settlementId) ===
        String(settlementId)
      );

    if (!settlement) {
      toast("Payable not found.");
      return;
    }

    const transactions =
      state.currentGroup?.transactions || [];

    const relatedExpenses =
      transactions
        .filter(transaction =>
          String(transaction.type).toUpperCase() === "EXPENSE" &&
          (transaction.participants || []).some(participant =>
            String(participant.userId) ===
              String(state.user.userId) &&
            Number(participant.shareAmount || 0) > 0
          )
        );

    const totalShare =
      relatedExpenses.reduce(
        (total, expense) => {

          const participant =
            (expense.participants || []).find(item =>
              String(item.userId) ===
              String(state.user.userId)
            );

          return total +
            Number(participant?.shareAmount || 0);

        },
        0
      );


    const paymentResult =
      await supabaseClient
        .from("payment_submissions")
        .select("*")
        .eq(
          "settlement_id",
          settlement.settlementId
        )
        .in(
          "status",
          ["CONFIRMED", "SUBMITTED"]
        )
        .order(
          "submitted_at",
          {
            ascending: false
          }
        );

    if (paymentResult.error) {
      throw paymentResult.error;
    }


    const payments =
      paymentResult.data || [];

    const confirmedPayments =
      payments.filter(payment =>
        String(payment.status).toUpperCase() ===
        "CONFIRMED"
      );

    const pendingPayments =
      payments.filter(payment =>
        String(payment.status).toUpperCase() ===
        "SUBMITTED"
      );


    const paidAmount =
      confirmedPayments.reduce(
        (total, payment) =>
          total +
          Number(payment.amount_paid || 0),
        0
      );


    const pendingAmount =
      pendingPayments.reduce(
        (total, payment) =>
          total +
          Number(payment.amount_paid || 0),
        0
      );


    const paymentRows =
      relatedExpenses.length
        ? relatedExpenses.map(expense => {

            const participant =
              (expense.participants || []).find(item =>
                String(item.userId) ===
                String(state.user.userId)
              );

            return `
              <div class="settle-expense-list-item">

                <div class="settle-expense-info">

                  <div class="settle-expense-name">
                    ${escapeHtml(
                      expense.description || "Expense"
                    )}
                  </div>

                  <div class="settle-expense-date">
                    ${
                      expense.date
                        ? new Date(
                            expense.date
                          ).toLocaleDateString()
                        : ""
                    }
                  </div>

                </div>

                <strong class="settle-expense-amount">
                  ${formatMoney(
                    Number(
                      participant?.shareAmount || 0
                    )
                  )}
                </strong>

              </div>
            `;

          }).join("")
        : `
          <div class="muted">
            No shared expenses found.
          </div>
        `;



    const confirmedHistory =
      confirmedPayments.length
        ? confirmedPayments.map(payment => `
            <div class="settle-payment-list-item">

              <div class="settle-payment-info">

                <div class="settle-payment-name">
                  Payment
                </div>

                <div class="settle-payment-date">
                  ${
                    payment.confirmed_at
                      ? new Date(
                          payment.confirmed_at
                        ).toLocaleString()
                      : "Confirmed"
                  }
                </div>

              </div>

              <div class="settle-payment-amount confirmed">
                ${formatMoney(
                  Number(payment.amount_paid || 0)
                )}
              </div>

              <div class="settle-payment-status confirmed">
                Confirmed
              </div>

            </div>
          `).join("")
        : `
          <div class="settle-payment-empty">
            No confirmed payments yet.
          </div>
        `;


    const pendingHistory =
      pendingPayments.length
        ? pendingPayments.map(payment => `
            <div class="settle-payment-list-item">

              <div class="settle-payment-info">

                <div class="settle-payment-name">
                  Payment
                </div>

                <div class="settle-payment-date">
                  ${
                    payment.submitted_at
                      ? new Date(
                          payment.submitted_at
                        ).toLocaleString()
                      : "Pending"
                  }
                </div>

              </div>

              <div class="settle-payment-amount pending">
                ${formatMoney(
                  Number(payment.amount_paid || 0)
                )}
              </div>

              <div class="settle-payment-status pending">
                Pending
              </div>

            </div>
          `).join("")
        : `
          <div class="settle-payment-empty">
            No pending payments.
          </div>
        `;



    openModal(`

      <h2>You owe ${escapeHtml(
        settlement.toDisplayName || settlement.toUsername || "Unknown"
      )}</h2>

      <p class="muted">
        Outstanding amount
      </p>

      <div class="settle-amount-summary">

        <div class="settle-amount-row">

          <span class="settle-amount-label">
            Remaining
          </span>

          <strong class="settle-amount-value">
            ${formatMoney(settlement.amount)}
          </strong>

        </div>

        <div class="settle-amount-row">

          <span class="settle-amount-label">
            Pending approval
          </span>

          <strong class="settle-amount-value">
            ${formatMoney(pendingAmount)}
          </strong>

        </div>

      </div>


      <div style="margin-top:24px;">

        <div class="section-title">
          Shared expenses
        </div>

        <div class="card">

          ${paymentRows}

          <div
            style="
              display:flex;
              justify-content:space-between;
              padding-top:16px;
              margin-top:8px;
              border-top:1px solid var(--border-color);
            "
          >

            <strong>
              Your total share
            </strong>

            <strong>
              ${formatMoney(totalShare)}
            </strong>

          </div>

        </div>

      </div>


      <div style="margin-top:24px;">

        <div class="section-title">
          Confirmed Payments
        </div>

        <div class="card">
          ${confirmedHistory}
        </div>

      </div>


      <div style="margin-top:24px;">

        <div class="section-title">
          Pending Payments
        </div>

        <div class="card">
          ${pendingHistory}
        </div>

      </div>


      <button
        type="button"
        class="primary-button green-button"
        style="width:100%;margin-top:20px;"
        onclick="openSettlePayment('${escapeHtml(
          settlement.settlementId
        )}')"
      >
        Settle ${formatMoney(settlement.amount)}
      </button>

    `);

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }

}

async function openReceivables() {

  setLoading(true, "Loading receivables...");

  try {

    const settlements =
      state.currentGroup?.settlements || [];

    const receivables =
      settlements.filter(item =>
        String(item.toUserId) ===
        String(state.user.userId) &&
        Number(item.amount || 0) > 0.009
      );

    const settlementIds =
      receivables.map(item => item.settlementId);

    let nudgeMap = {};

    if (settlementIds.length) {

      const { data: nudgeRows, error: nudgeError } =
        await supabaseClient
          .from("nudges")
          .select("settlement_id, created_at")
          .in("settlement_id", settlementIds)
          .order("created_at", {
            ascending: false
          });

      if (nudgeError) {
        throw nudgeError;
      }

      (nudgeRows || []).forEach(nudge => {

        if (!nudgeMap[nudge.settlement_id]) {
          nudgeMap[nudge.settlement_id] =
            nudge.created_at;
        }

      });

    }

    openModal(`

      <h2>Receivables</h2>

      <p class="muted">
        What others still need to pay you.
      </p>

      ${
        receivables.length
          ? `
            <div class="balance-detail-list">

              ${receivables.map(item => `

                <div
                  class="balance-detail-row"
                  style="
                    align-items:center;
                  "
                >

                  <div style="flex:1;min-width:0;">

                    <div class="user-name">
                      ${escapeHtml(
                        item.fromDisplayName || item.fromUsername || "Unknown"
                      )}
                    </div>

                    <div
                      style="
                        font-size:24px;
                        font-weight:700;
                        margin-top:4px;
                      "
                    >
                      ${formatMoney(item.amount)}
                    </div>

                    <div class="muted">
                      Still owed to you
                    </div>

                    ${
                      nudgeMap[item.settlementId]
                        ? `
                          <div
                            class="nudge-last-sent"
                            style="margin-top:4px;"
                          >
                            Last nudged
                            ${formatNudgeTime(
                              nudgeMap[item.settlementId]
                            )}
                          </div>
                        `
                        : ""
                    }

                  </div>

                  <div
                    style="
                      display:flex;
                      flex-direction:column;
                      gap:8px;
                      align-items:flex-end;
                    "
                  >

                    <button
                      type="button"
                      class="small-button"
                      onclick="openReceivableDetails('${escapeHtml(item.settlementId)}')"
                    >
                      View details
                    </button>

                    <button
                      type="button"
                      class="small-button nudge-button"
                      onclick="openNudgeConfirmation('${escapeHtml(item.settlementId)}')"
                    >
                      Nudge
                    </button>

                    <button
                      type="button"
                      class="small-button payme-receivable-button"
                      onclick="createSettlementPayMeLink('${escapeHtml(item.settlementId)}')"
                    >
                      PayMe
                    </button>

                  </div>

                </div>

              `).join("")}

            </div>
          `
          : `
            <div class="muted">
              Nobody owes you right now.
            </div>
          `
      }

    `);

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }

}


async function openReceivableDetails(settlementId) {

  setLoading(true, "Loading receivable details...");

  try {

    const settlements =
      await loadCurrentSettlements();

    const settlement =
      settlements.find(item =>
        String(item.settlementId) ===
        String(settlementId)
      );

    if (!settlement) {
      toast("Receivable not found.");
      return;
    }

    const transactions =
      state.currentGroup?.transactions || [];

    const relatedExpenses =
      transactions
        .filter(transaction =>
          String(transaction.type).toUpperCase() === "EXPENSE" &&
          (transaction.participants || []).some(participant =>
            String(participant.userId) ===
              String(settlement.fromUserId) &&
            Number(participant.shareAmount || 0) > 0
          )
        );

    const originalAmount =
      relatedExpenses.reduce(
        (total, expense) => {

          const participant =
            (expense.participants || []).find(item =>
              String(item.userId) ===
              String(settlement.fromUserId)
            );

          return total +
            Number(participant?.shareAmount || 0);

        },
        0
      );


    const paymentResult =
      await supabaseClient
        .from("payment_submissions")
        .select("*")
        .eq(
          "settlement_id",
          settlement.settlementId
        )
        .in(
          "status",
          ["CONFIRMED", "SUBMITTED"]
        )
        .order(
          "submitted_at",
          {
            ascending: false
          }
        );

    if (paymentResult.error) {
      throw paymentResult.error;
    }


    const payments =
      paymentResult.data || [];

    const confirmedPayments =
      payments.filter(payment =>
        String(payment.status).toUpperCase() ===
        "CONFIRMED"
      );

    const pendingPayments =
      payments.filter(payment =>
        String(payment.status).toUpperCase() ===
        "SUBMITTED"
      );


    const paidAmount =
      confirmedPayments.reduce(
        (total, payment) =>
          total +
          Number(payment.amount_paid || 0),
        0
      );


    const pendingAmount =
      pendingPayments.reduce(
        (total, payment) =>
          total +
          Number(payment.amount_paid || 0),
        0
      );


    const expenseRows =
      relatedExpenses.length
        ? relatedExpenses.map(expense => {

            const participant =
              (expense.participants || []).find(item =>
                String(item.userId) ===
                String(settlement.fromUserId)
              );

            return `
              <div class="receivable-detail-list-item">

                <div style="flex:1;">

                  <div class="user-name">
                    ${escapeHtml(
                      expense.description || "Expense"
                    )}
                  </div>

                  <div class="muted">
                    ${
                      expense.date
                        ? new Date(expense.date)
                            .toLocaleDateString()
                        : ""
                    }
                  </div>

                </div>

                <strong>
                  ${formatMoney(
                    Number(
                      participant?.shareAmount || 0
                    )
                  )}
                </strong>

              </div>
            `;

          }).join("")
        : `
          <div class="muted">
            No shared expenses found.
          </div>
        `;


    const confirmedHistory =
      confirmedPayments.length
        ? confirmedPayments.map(payment => `

            <div
              class="receivable-flat-row"
              style="align-items:flex-start;"
            >

              <div style="flex:1;">

                <div class="user-name">
                  Payment
                </div>

                <div class="muted">
                  ${
                    payment.confirmed_at
                      ? new Date(
                          payment.confirmed_at
                        ).toLocaleString()
                      : "Confirmed"
                  }
                </div>

              </div>

              <div style="text-align:right;">

                <strong>
                  ${formatMoney(
                    Number(payment.amount_paid || 0)
                  )}
                </strong>

                <div class="muted">
                  Confirmed
                </div>

              </div>

            </div>

          `).join("")
        : `
          <div class="muted">
            No confirmed payments yet.
          </div>
        `;


    const pendingHistory =
      pendingPayments.length
        ? pendingPayments.map(payment => `

            <div
              class="receivable-flat-row"
              style="align-items:flex-start;"
            >

              <div style="flex:1;">

                <div class="user-name">
                  Payment
                </div>

                <div class="muted">
                  ${
                    payment.submitted_at
                      ? new Date(
                          payment.submitted_at
                        ).toLocaleString()
                      : "Pending"
                  }
                </div>

              </div>

              <div style="text-align:right;">

                <strong>
                  ${formatMoney(
                    Number(payment.amount_paid || 0)
                  )}
                </strong>

                <div class="muted">
                  Waiting for your approval
                </div>

              </div>

            </div>

          `).join("")
        : `
          <div class="muted">
            No pending payments.
          </div>
        `;


    openModal(`

      <h2>
        ${escapeHtml(
          settlement.fromDisplayName || settlement.fromUsername || "Unknown"
        )} owes you
      </h2>


      <div class="receivable-summary-list">

        <div class="receivable-summary-row">

          <span class="muted">
            Remaining
          </span>

          <strong>
            ${formatMoney(settlement.amount)}
          </strong>

        </div>

        <div class="receivable-summary-row">

          <span class="muted">
            Pending approval
          </span>

          <strong>
            ${formatMoney(pendingAmount)}
          </strong>

        </div>

      </div>


      <div style="margin-top:24px;">

        <div class="section-title">
          Payment summary
        </div>

        <div class="card receivable-section-card">

          <div class="receivable-flat-row">
            <span class="muted">
              Original amount
            </span>

            <strong>
              ${formatMoney(
                Math.max(
                  originalAmount,
                  Number(settlement.amount) +
                  paidAmount
                )
              )}
            </strong>
          </div>

          <div class="receivable-flat-row">
            <span class="muted">
              Paid so far
            </span>

            <strong>
              ${formatMoney(paidAmount)}
            </strong>
          </div>

          <div class="receivable-flat-row">
            <strong>
              Remaining
            </strong>

            <strong>
              ${formatMoney(settlement.amount)}
            </strong>
          </div>

        </div>

      </div>


      <div style="margin-top:24px;">

        <div class="section-title">
          Shared expenses
        </div>

        <div class="card receivable-section-card">
          <div class="receivable-section-list">
            ${expenseRows}
          </div>
        </div>

      </div>


      <div style="margin-top:24px;">

        <div class="section-title">
          Confirmed Payments
        </div>

        <div class="card receivable-section-card">

          <div class="receivable-detail-list">
          ${confirmedHistory}
        </div>

      </div>


      <div style="margin-top:24px;">

        </div>

        <div class="section-title">
          Pending Payments
        </div>

        <div class="card receivable-section-card">
          <div class="receivable-section-list">
            ${pendingHistory}
          </div>
        </div>

      </div>

    `);

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }

}

async function openSettlementsModal() {

  setLoading(true, "Loading settlements...");

  try {

    const result = await getSettlementsFromSupabase(
      state.currentGroup.group.groupId
    );

    const settlements = result.data.settlements || [];

    openModal(`

      <h2>Settle Up</h2>

      <p class="muted">
        These are the simplest transfers based on the current balances.
      </p>

      ${
        settlements.length
        ? `
          <div class="card">

            ${settlements.map(renderSettlement).join("")}

          </div>
        `
        : `
          <div class="card empty">
            Everyone is settled up.
          </div>
        `
      }

      <div
        id="pendingPaymentsSection"
        style="margin-top:24px;"
      >
        <div class="section-title">
          Pending Payments
        </div>

        <div
          id="pendingPaymentsList"
          class="card"
        >
          <div class="muted">
            Loading pending payments...
          </div>
        </div>
      </div>

    `);

    await loadPendingPayments();

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }
}


async function loadPendingPayables() {

  const container = $("#pendingPayablesList");

  if (!container) {
    return;
  }

  try {

    const { data: settlements, error } =
      await supabaseClient
        .from("settlements")
        .select(`
          id,
          group_id,
          from_user_id,
          to_user_id,
          amount,
          status
        `)
        .eq(
          "group_id",
          state.currentGroup.group.groupId
        )
        .eq(
          "from_user_id",
          state.user.userId
        )
        .eq(
          "status",
          "UNPAID"
        )
        .order("created_at", {
          ascending: true
        });

    if (error) {
      throw error;
    }

    const rows = settlements || [];

    if (!rows.length) {

      container.innerHTML = `
        <div class="muted pending-list-empty">
          No payments to settle.
        </div>
      `;

      return;
    }

    const membersResult =
      await supabaseClient.rpc(
        "get_group_members",
        {
          lookup_group_id:
            state.currentGroup.group.groupId
        }
      );

    if (membersResult.error) {
      throw membersResult.error;
    }

    const memberMap = {};

    (membersResult.data || []).forEach(member => {

      memberMap[String(member.user_id)] =
        member.display_name || "";

    });

    container.innerHTML =
      rows.map(item => `

        <div class="pending-flat-row">

          <div class="pending-flat-label">
            Pending payable
          </div>

          <div class="pending-flat-amount">
            ${formatMoney(item.amount)}
          </div>

          <button
            type="button"
            class="pending-flat-action pending-settle-action"
            onclick="openSettlePayment('${escapeHtml(item.id)}')"
          >
            Settle
          </button>

        </div>

      `).join("");

  } catch (error) {

    console.error(
      "LOAD PENDING PAYABLES ERROR:",
      error
    );

    container.innerHTML = `
      <div class="muted pending-list-empty">
        Unable to load payments to settle.
      </div>
    `;

  }

}

async function loadPendingPayments() {

  const container = $("#pendingPaymentsList");

  if (!container) {
    return;
  }

  try {

    const result = await getPendingPaymentsFromSupabase(
      state.currentGroup.group.groupId
    );

    const payments =
      result.payments ||
      result.data?.payments ||
      [];

    if (!payments.length) {

      container.innerHTML = `
        <div class="muted" style="text-align:center;padding:10px;">
          No pending payments.
        </div>
      `;

      return;
    }

    container.innerHTML =
      payments
        .map(renderPendingPayment)
        .join("");

  } catch (error) {

    container.innerHTML = `
      <div class="muted">
        ${escapeHtml(error.message)}
      </div>
    `;
  }
}


function renderPendingPayment(payment) {

  return `
    <div class="pending-flat-row">

      <div class="pending-flat-label">
        Payment received
      </div>

      <div class="pending-flat-amount">
        ₱${Number(payment.amountPaid || 0).toLocaleString(
          "en-PH",
          {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          }
        )}
      </div>

      <button
        type="button"
        class="pending-flat-action pending-review-action"
        onclick="reviewPayment('${escapeHtml(payment.paymentSubmissionId)}')"
      >
        Review
      </button>

    </div>
  `;
}

async function openPaymentTransaction(paymentSubmissionId) {
  try {
    setLoading(true, "Loading payment details...");

    const { data: payment, error } = await supabaseClient
      .from("payment_submissions")
      .select(`
        id,
        group_id,
        payment_option,
        amount_due,
        amount_paid,
        proof_file_url,
        notes,
        status,
        submitted_at,
        confirmed_at,
        rejected_at,
        rejection_reason,
        payer_user_id,
        recipient_user_id
      `)
      .eq("id", paymentSubmissionId)
      .single();

    if (error) throw error;
    if (!payment) throw new Error("Payment transaction not found.");

    const {
      data: groupMembers,
      error: memberError
    } = await supabaseClient.rpc(
      "get_group_members",
      {
        lookup_group_id: payment.group_id
      }
    );

    if (memberError) throw memberError;

    const payerProfile =
      (groupMembers || []).find(
        member =>
          String(member.user_id) ===
          String(payment.payer_user_id)
      );

    const recipientProfile =
      (groupMembers || []).find(
        member =>
          String(member.user_id) ===
          String(payment.recipient_user_id)
      );

    const payerName =
      payerProfile?.display_name ||
      payerProfile?.username ||
      "Unknown";

    const recipientName =
      recipientProfile?.display_name ||
      recipientProfile?.username ||
      "Unknown";

    let proofHtml = "";

    if (payment.proof_file_url) {
      const proofUrl =
        await getPaymentQrUrl(payment.proof_file_url);

      if (proofUrl) {
        proofHtml = `
          <div style="margin-top:18px;">
            <div class="muted" style="margin-bottom:8px;">
              Payment Proof
            </div>

            <a
              href="${escapeHtml(proofUrl)}"
              target="_blank"
              rel="noopener noreferrer"
              class="secondary-button"
              style="
                display:inline-flex;
                align-items:center;
                justify-content:center;
                text-decoration:none;
              "
            >
              View Proof
            </a>
          </div>
        `;
      }
    }

    let statusHtml = "";

    if (String(payment.status).toUpperCase() === "CONFIRMED") {
      statusHtml = `
        <span class="status-confirmed">
          Confirmed
        </span>
      `;
    } else if (String(payment.status).toUpperCase() === "REJECTED") {
      statusHtml = `
        <span class="status-rejected">
          Rejected
        </span>
      `;
    } else if (String(payment.status).toUpperCase() === "SUBMITTED") {
      statusHtml = `
        <span class="status-pending">
          Pending
        </span>
      `;
    } else {
      statusHtml = escapeHtml(payment.status || "Unknown");
    }

    openModal(`
      <div class="modal-confirmation">

        <h2>Payment Details</h2>

        <div
          class="card"
          style="
            margin-top:16px;
            padding:20px;
          "
        >

          <div class="muted">
            From
          </div>

          <div
            style="
              font-size:18px;
              font-weight:700;
              margin-top:4px;
            "
          >
            ${escapeHtml(payerName)}
          </div>

          <div
            class="muted"
            style="margin-top:16px;"
          >
            To
          </div>

          <div
            style="
              font-size:18px;
              font-weight:700;
              margin-top:4px;
            "
          >
            ${escapeHtml(recipientName)}
          </div>

          <div
            class="muted"
            style="margin-top:16px;"
          >
            Payment Method
          </div>

          <div
            style="
              font-size:17px;
              font-weight:700;
              margin-top:4px;
            "
          >
            ${escapeHtml(payment.payment_option || "—")}
          </div>

          <div
            class="muted"
            style="margin-top:16px;"
          >
            Amount Paid
          </div>

          <div
            style="
              font-size:28px;
              font-weight:700;
              margin-top:4px;
            "
          >
            ${formatMoney(Number(payment.amount_paid || 0))}
          </div>

          <div
            class="muted"
            style="margin-top:16px;"
          >
            Status
          </div>

          <div style="margin-top:6px;">
            ${statusHtml}
          </div>

          ${
            payment.notes
              ? `
                <div
                  class="muted"
                  style="margin-top:16px;"
                >
                  Notes
                </div>

                <div style="margin-top:4px;">
                  ${escapeHtml(payment.notes)}
                </div>
              `
              : ""
          }

          ${
            payment.rejection_reason
              ? `
                <div
                  class="muted"
                  style="margin-top:16px;"
                >
                  Rejection Reason
                </div>

                <div
                  style="
                    margin-top:4px;
                    color:var(--red);
                  "
                >
                  ${escapeHtml(payment.rejection_reason)}
                </div>
              `
              : ""
          }

          ${proofHtml}

        </div>

      </div>
    `);

  } catch (error) {
    console.error(
      "OPEN PAYMENT TRANSACTION ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to load payment details."
    );

  } finally {
    setLoading(false);
  }
}


async function reviewPayment(paymentSubmissionId) {

  setLoading(true, "Loading payment review...");

  try {

    const result =
      await getPendingPaymentsFromSupabase(
        state.currentGroup.group.groupId
      );


    const payments =
      result.payments ||
      result.data?.payments ||
      [];


    const payment =
      payments.find(
        item =>
          String(
            item.paymentSubmissionId
          ) ===
          String(
            paymentSubmissionId
          )
      );


    if (!payment) {

      toast(
        "Payment submission not found."
      );

      return;
    }


    const amountDue =
      Number(
        payment.amountDue || 0
      );


    const amountPaid =
      Number(
        payment.amountPaid || 0
      );

    // Get the actual payment provider/bank from the
    // payment detail selected when the payment was submitted.
    let actualPaymentMethod =
      String(payment.paymentOption || "").trim();

    if (payment.paymentDetailId) {
      const {
        data: paymentDetail,
        error: paymentDetailError
      } = await supabaseClient
        .from("payment_details")
        .select("payment_option")
        .eq("id", payment.paymentDetailId)
        .maybeSingle();

      if (!paymentDetailError && paymentDetail?.payment_option) {
        actualPaymentMethod =
          String(paymentDetail.payment_option).trim();
      }
    }

    const proofFileUrl =
      String(
        payment.proofFileUrl || ""
      ).trim();

    const proofDisplayUrl =
      proofFileUrl
        ? await getPaymentQrUrl(proofFileUrl)
        : "";


    openModal(`

      <h2>
        Review Payment
      </h2>

      <p class="muted">
        Review this payment before confirming it.
      </p>


      <div
        class="card"
        style="margin-top:16px;"
      >


        <div
          style="
            margin-top:0;
            font-size:16px;
          "
        >
          <strong>Payment Method:</strong>
          <span>
            ${escapeHtml(
              actualPaymentMethod ||
              "—"
            )}
          </span>
        </div>


        <div
          style="margin-top:16px;"
        >

          <div class="muted">
            Amount Due
          </div>

          <strong
            style="font-size:20px;"
          >
            ₱${amountDue.toLocaleString(
              "en-PH",
              {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
              }
            )}
          </strong>

        </div>


        <div
          style="margin-top:12px;"
        >

          <div class="muted">
            Amount Paid
          </div>

          <strong
            style="font-size:20px;"
          >
            ₱${amountPaid.toLocaleString(
              "en-PH",
              {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
              }
            )}
          </strong>

        </div>


        <div
          style="margin-top:20px;"
        >

          <div class="muted">
            Payment Proof
          </div>


          ${
            proofFileUrl
              ? `
                <div
                  style="
                    margin-top:8px;
                    display:flex;
                    align-items:center;
                    justify-content:space-between;
                    display:flex;
                    flex-direction:column;
                    align-items:flex-start;
                    gap:12px;
                    padding:12px;
                    border:1px solid #e5e7eb;
                    border-radius:10px;
                  "
                >

                  <div>

                    <strong>
                      Payment proof attached
                    </strong>

                    <div
                      class="muted"
                      style="margin-top:3px;"
                    >
                      Uploaded payment proof
                    </div>

                  </div>


                  <a
  href="${escapeHtml(proofDisplayUrl)}"
  target="_blank"
  rel="noopener noreferrer"
  class="secondary-button"
  style="display:inline-flex;align-items:center;justify-content:center;text-decoration:none;"
>
  View Proof
</a>

                </div>
              `
              : `
                <div
                  class="muted"
                  style="
                    margin-top:8px;
                    padding:12px;
                    border:1px dashed #e5e7eb;
                    border-radius:10px;
                  "
                >
                  No payment proof attached.
                </div>
              `
          }

        </div>


        ${
          payment.notes
            ? `
              <div
                style="margin-top:20px;"
              >

                <div class="muted">
                  Note
                </div>

                <div
                  style="margin-top:4px;"
                >
                  ${escapeHtml(
                    payment.notes
                  )}
                </div>

              </div>
            `
            : ""
        }

      </div>


      <div
        class="payment-review-actions"
        style="
          display:flex;
          gap:10px;
          margin-top:20px;
        "
      >

        <button
          type="button"
          class="secondary-button"
          style="flex:1;"
          onclick="openRejectPayment('${escapeHtml(
            payment.paymentSubmissionId
          )}')"
        >
          Reject
        </button>


        <button
          type="button"
          class="primary-button"
          style="flex:1;"
          onclick="confirmPaymentSubmission('${escapeHtml(
            payment.paymentSubmissionId
          )}')"
        >
          Confirm Payment
        </button>

      </div>

    `);

  } catch (error) {

    toast(
      error.message
    );

  } finally {

    setLoading(false);

  }

}


async function confirmPaymentSubmission(paymentSubmissionId) {

  try {

    const id =
      String(paymentSubmissionId || "").trim();

    if (!id) {
      toast("Payment submission not found.");
      return;
    }

    await confirmSubmittedPayment(id);

  } catch (error) {

    console.error(
      "CONFIRM PAYMENT SUBMISSION ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to open payment confirmation."
    );

  }

}


async function confirmSubmittedPayment(paymentSubmissionId) {

  openModal(`
    <div class="modal-confirmation">

      <h2>Confirm Payment?</h2>

      <p class="muted">
        Confirm that you received this payment.
        The settlement will be marked as paid.
      </p>

      <div
        style="
          display:flex;
          justify-content:flex-end;
          gap:10px;
          margin-top:20px;
        "
      >

        <button
          type="button"
          class="secondary-button"
          onclick="reviewPayment('${escapeHtml(paymentSubmissionId)}')"
        >
          Cancel
        </button>

        <button
          type="button"
          class="primary-button"
          onclick="processConfirmPayment('${escapeHtml(paymentSubmissionId)}')"
        >
          Confirm Payment
        </button>

      </div>

    </div>
  `);
}



async function cancelPayment(paymentSubmissionId) {

  openModal(`
    <div class="modal-confirmation">

      <h2>Cancel Payment?</h2>

      <p class="muted">
        Are you sure you want to cancel this payment submission?
      </p>

      <div class="close-group-confirmation-actions">

        <button
          type="button"
          class="close-group-cancel-button"
          onclick="closeModal()"
        >
          Keep Payment
        </button>

        <button
          type="button"
          class="close-group-confirm-button"
          onclick="confirmCancelPayment('${escapeHtml(paymentSubmissionId)}')"
        >
          Cancel Payment
        </button>

      </div>

    </div>
  `);

}


async function confirmCancelPayment(paymentSubmissionId) {

  closeModal();

  setLoading(
    true,
    "Cancelling payment..."
  );

  try {

    const {
      data: {
        user
      },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error("Please log in first.");
    }

    const {
      data: payment,
      error: paymentError
    } = await supabaseClient
      .from("payment_submissions")
      .select(`
        id,
        payer_user_id,
        status
      `)
      .eq("id", paymentSubmissionId)
      .single();

    if (paymentError || !payment) {
      throw new Error("Payment submission not found.");
    }

    if (
      String(payment.payer_user_id) !==
      String(user.id)
    ) {
      throw new Error(
        "Only the person who submitted the payment can cancel it."
      );
    }

    if (
      String(payment.status).toUpperCase() !==
      "SUBMITTED"
    ) {
      throw new Error(
        "Only pending payments can be cancelled."
      );
    }

    const {
      error: updateError
    } = await supabaseClient
      .from("payment_submissions")
      .update({
        status: "CANCELLED"
      })
      .eq("id", paymentSubmissionId)
      .eq("payer_user_id", user.id)
      .eq("status", "SUBMITTED");

    if (updateError) {
      console.error(
        "CANCEL PAYMENT UPDATE ERROR:",
        updateError
      );
      throw updateError;
    }

    toast("Payment cancelled.");

    await refreshCurrentGroup();

  } catch (error) {

    console.error(
      "CANCEL PAYMENT ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to cancel the payment."
    );

  } finally {

    setLoading(false);

  }

}


async function processConfirmPayment(paymentSubmissionId) {

  try {

    setLoading(
      true,
      "Confirming payment..."
    );

    const { error } = await supabaseClient
      .from("payment_submissions")
      .update({
        status: "CONFIRMED",
        confirmed_at: new Date().toISOString()
      })
      .eq("id", paymentSubmissionId)
      .eq("recipient_user_id", state.user.userId)
      .eq("status", "SUBMITTED");

    if (error) {
      throw error;
    }

    closeModal();

    toast(
      "Payment confirmed."
    );

    await openSettlementsModal();

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);
  }
}


function openRejectPayment(paymentSubmissionId) {

  openModal(`
    <div class="modal-confirmation">

      <h2>Reject Payment?</h2>

      <p class="muted">
        Please provide a reason so the payer knows
        what needs to be corrected.
      </p>

      <label style="display:block;margin-top:16px;">
        Reason
        <textarea
          id="paymentRejectionReason"
          rows="4"
          maxlength="500"
          placeholder="e.g. Payment amount does not match, wrong account, or proof is unclear."
          required
        ></textarea>
      </label>

      <div
        style="
          display:flex;
          justify-content:flex-end;
          gap:10px;
          margin-top:20px;
        "
      >

        <button
          type="button"
          class="secondary-button"
          onclick="reviewPayment('${escapeHtml(paymentSubmissionId)}')"
        >
          Cancel
        </button>

        <button
  type="button"
  class="primary-button reject-payment-button"
  onclick="processRejectPayment('${escapeHtml(paymentSubmissionId)}')"
>
  Reject Payment
</button>

      </div>

    </div>
  `);
}


async function processRejectPayment(paymentSubmissionId) {

  const reasonElement =
    $("#paymentRejectionReason");

  const rejectionReason =
    reasonElement
      ? reasonElement.value.trim()
      : "";

  if (!rejectionReason) {
    toast("Please provide a reason for rejecting the payment.");
    return;
  }

  try {

    setLoading(
      true,
      "Rejecting payment..."
    );

    const { error } = await supabaseClient
      .from("payment_submissions")
      .update({
        status: "REJECTED",
        rejected_at: new Date().toISOString(),
        rejection_reason: rejectionReason
      })
      .eq("id", paymentSubmissionId)
      .eq("recipient_user_id", state.user.userId)
      .eq("status", "SUBMITTED");

    if (error) {
      throw error;
    }

    closeModal();

    toast(
      "Payment rejected."
    );

    await openSettlementsModal();

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);
  }
}


function renderSettlement(item) {

  const isPaid =
    String(item.status).toUpperCase() === "PAID";

  const isPayer =
    String(item.fromUserId) ===
    String(state.user.userId);

  return `
    <div class="settlement-row">

      <div>

        <strong>
          ${escapeHtml(item.fromDisplayName || item.fromUsername || "Unknown")}
          →
          ${escapeHtml(item.toDisplayName || item.toUsername || "Unknown")}
        </strong>

        <div class="muted">
          ${isPayer
            ? `You owe ${escapeHtml(item.toDisplayName || item.toUsername || "Unknown")}`
            : `${escapeHtml(item.fromDisplayName || item.fromUsername || "Unknown")} owes you`
          }
        </div>

        <div style="margin-top:6px;font-size:18px;font-weight:700;">
          ₱${Number(item.amount).toLocaleString(
            "en-PH",
            {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            }
          )}
        </div>

        <div class="muted" style="margin-top:4px;">
          ${
            isPaid
              ? "Payment confirmed"
              : "Suggested settlement"
          }
        </div>

      </div>

      ${
        isPaid
          ? `
            <span class="muted">
              Paid
            </span>
          `
          : isPayer
            ? `
              <button
                class="small-button green-button"
                onclick="openSettlePayment('${escapeHtml(item.settlementId)}')"
              >
                Settle Up
              </button>
            `
            : `
              <span class="muted">
                Awaiting payment
              </span>
            `
      }

    </div>
  `;
}


async function openSettlePayment(settlementId) {

  if (
    String(state.currentGroup?.group?.status).toUpperCase() ===
    "CLOSED"
  ) {
    toast("This group is closed. New payments cannot be submitted.");
    return;
  }

  setLoading(true, "Loading settlement...");

  try {

    const settlementResult =
      await getSettlementsFromSupabase(
        state.currentGroup.group.groupId
      );

    const settlements =
      settlementResult.settlements ||
      settlementResult.data?.settlements ||
      [];

    const settlement =
      settlements.find(
        item =>
          String(item.settlementId) ===
          String(settlementId)
      );

    if (!settlement) {

      toast(
        "Settlement not found."
      );

      return;
    }

    /*
     * Calculate the current outstanding balance.
     * settlement.amount is the original settlement amount;
     * payments already confirmed/submitted must be deducted.
     */
    const settlementTransactions =
      (state.currentGroup?.transactions || [])
        .filter(transaction =>
          String(transaction.type || "").toUpperCase() === "PAYMENT" &&
          String(transaction.settlementId) ===
            String(settlement.settlementId) &&
          String(transaction.fromUserId) ===
            String(state.user.userId)
        );

    const confirmedPaid =
      settlementTransactions
        .filter(transaction =>
          String(transaction.status || "").toUpperCase() === "CONFIRMED"
        )
        .reduce(
          (total, transaction) =>
            total + Number(transaction.amountPaid || 0),
          0
        );

    const pendingPaid =
      settlementTransactions
        .filter(transaction =>
          String(transaction.status || "").toUpperCase() === "SUBMITTED"
        )
        .reduce(
          (total, transaction) =>
            total + Number(transaction.amountPaid || 0),
          0
        );

    const remainingAmount =
      Math.max(
        0,
        Number(settlement.amount || 0) -
          confirmedPaid -
          pendingPaid
      );

    if (remainingAmount <= 0) {
      toast("This settlement has already been fully paid or is awaiting confirmation.");
      return;
    }

    if (
      String(settlement.fromUserId) !==
      String(state.user.userId)
    ) {

      toast(
        "You are not the payer for this settlement."
      );

      return;
    }

    if (
      String(settlement.status).toUpperCase() ===
      "PAID"
    ) {

      toast(
        "This settlement has already been paid."
      );

      return;
    }

    const {
      data: paymentDetails,
      error: paymentDetailsError
    } = await supabaseClient
      .rpc("get_user_payment_details", {
        lookup_user_id: settlement.toUserId
      });

    if (paymentDetailsError) {
      throw paymentDetailsError;
    }

    const normalizedPaymentDetails =
      await Promise.all(
        (paymentDetails || []).map(async detail => ({
          paymentDetailId: detail.id,
          userId: detail.user_id,
          paymentOption: detail.payment_option,
          accountNumber: detail.account_number,
          accountName: detail.account_name,
          qrFileUrl: detail.qr_file_url,
          qrDisplayUrl: detail.qr_file_url
            ? await getPaymentQrUrl(detail.qr_file_url)
            : "",
          isPreferred: detail.is_preferred,
          status: detail.status,
          createdAt: detail.created_at,
          updatedAt: detail.updated_at
        }))
      );

    /*
     * Preserve the amount while the payment modal
     * is being worked on.
     *
     * If the modal is opened for the first time,
     * use the current settlement amount.
     */
    const existingAmount =
      window.owemeSettlementDrafts &&
      window.owemeSettlementDrafts[settlementId] &&
      window.owemeSettlementDrafts[settlementId].amount;

    const draftAmount =
      existingAmount !== undefined &&
      existingAmount !== null &&
      existingAmount !== ""
        ? existingAmount
        : remainingAmount.toFixed(2);


    openModal(`

      <h2>
        Settle Up
      </h2>

      <p class="muted">

        You owe

        <strong>
          ${escapeHtml(settlement.toDisplayName || settlement.toUsername || "Unknown")}
        </strong>

      </p>


      <div
        class="card"
        style="margin-top:16px;"
      >

        <div class="muted">
          Amount Due
        </div>

        <div
          style="
            font-size:28px;
            font-weight:700;
            margin-top:4px;
          "
        >

          ₱${remainingAmount.toLocaleString(
            "en-PH",
            {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            }
          )}

        </div>

      </div>


      <div style="margin-top:18px;">

        <h3>
          Payment Method
        </h3>


        ${
          normalizedPaymentDetails.length
            ? normalizedPaymentDetails
                .map(
                  detail => `

                    <label class="card settle-payment-option">

                      <input
                        type="radio"
                        name="settlePaymentMethod"
                        value="${escapeHtml(detail.paymentDetailId)}"
                        data-payment-option="${escapeHtml(detail.paymentOption || "")}"
                        ${
                          detail.isPreferred
                            ? "checked"
                            : ""
                        }
                        class="settle-payment-radio"
                      >

                      <div style="flex:1;">

                        <div>
                          <strong>Payment Method:</strong>
                          ${escapeHtml(detail.paymentOption)}
                        </div>

                        ${
                          detail.accountNumber
                            ? `
                              <div class="muted">
                                <strong>Account Number:</strong>
                                ${escapeHtml(detail.accountNumber)}
                              </div>
                            `
                            : ""
                        }

                        ${
                          detail.accountName
                            ? `
                              <div class="muted">
                                <strong>Account Name:</strong>
                                ${escapeHtml(detail.accountName)}
                              </div>
                            `
                            : ""
                        }

                        ${
                          detail.isPreferred
                            ? `
                              <div
                                class="muted"
                                style="margin-top:4px;"
                              >
                                Preferred
                              </div>
                            `
                            : ""
                        }

                        ${
                          detail.qrDisplayUrl
                            ? `
                              <a
                                href="${escapeHtml(
                                  detail.qrDisplayUrl
                                )}"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="secondary-button settle-payment-qr-button"
                                style="text-decoration:none;"
                              >
                                View QR Code
                              </a>
                            `
                            : ""
                        }

                      </div>

                    </label>

                  `
                )
                .join("")
            : `

              <div class="card empty">

                ${escapeHtml(
                  settlement.toDisplayName || settlement.toUsername || "Unknown"
                )}

                has not added any payment
                details yet.

              </div>

            `
        }

      </div>


      ${
        normalizedPaymentDetails.length
          ? `

            <form
              id="submitPaymentForm"
              style="margin-top:20px;"
            >

              <label>

                Amount Paid

                <input
                  id="settleAmountPaid"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value="${escapeHtml(
                    draftAmount
                  )}"
                  required
                >

              </label>


              <label
                style="margin-top:12px;"
              >

                Payment Proof

                <input
                  id="settlePaymentProof"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                >

                <div class="muted">
                  Optional for now.
                </div>

              </label>


              <label
                style="margin-top:12px;"
              >

                Notes

                <textarea
                  id="settlePaymentNotes"
                  rows="3"
                  maxlength="500"
                  placeholder="Optional note"
                ></textarea>

              </label>


              <button
                class="primary-button"
                type="submit"
                style="
                  margin-top:16px;
                  width:100%;
                "
              >

                Submit Payment

              </button>

            </form>

          `
          : ""
      }

    `);


    if (!window.owemeSettlementDrafts) {

      window.owemeSettlementDrafts = {};

    }


    if (paymentDetails.length) {

      const amountInput =
        $("#settleAmountPaid");

      const proofInput =
        $("#settlePaymentProof");

      const notesInput =
        $("#settlePaymentNotes");


      /*
       * Save the amount immediately whenever
       * the user changes it.
       */
      amountInput.addEventListener(
        "input",
        () => {

          window.owemeSettlementDrafts[
            settlementId
          ] = {

            ...(
              window.owemeSettlementDrafts[
                settlementId
              ] || {}
            ),

            amount:
              amountInput.value

          };

        }
      );


      /*
       * Explicitly preserve the amount when
       * the file picker changes focus.
       */
      proofInput.addEventListener(
        "change",
        () => {

          window.owemeSettlementDrafts[
            settlementId
          ] = {

            ...(
              window.owemeSettlementDrafts[
                settlementId
              ] || {}
            ),

            amount:
              amountInput.value,

            proofFile:
              proofInput.files &&
              proofInput.files.length
                ? proofInput.files[0]
                : null

          };

        }
      );


      /*
       * Preserve notes as well.
       */
      notesInput.addEventListener(
        "input",
        () => {

          window.owemeSettlementDrafts[
            settlementId
          ] = {

            ...(
              window.owemeSettlementDrafts[
                settlementId
              ] || {}
            ),

            amount:
              amountInput.value,

            notes:
              notesInput.value

          };

        }
      );


      $("#submitPaymentForm")
        .addEventListener(
          "submit",
          event =>
            submitSettlementPayment(
              event,
              settlement
            )
        );

    }

  } catch (error) {

    console.error(
      "OPEN SETTLE PAYMENT ERROR:",
      error
    );

    toast(
      error.message ||
      "Something went wrong. Please try again."
    );

  } finally {

    setLoading(false);

  }

}


function preparePaymentProof(file) {

  return new Promise(
    (resolve, reject) => {

      if (!file) {

        reject(
          new Error(
            "Payment proof file is required."
          )
        );

        return;
      }

      if (file.size > 10 * 1024 * 1024) {

        reject(
          new Error(
            "Payment proof must be 10 MB or smaller."
          )
        );

        return;
      }

      const reader =
        new FileReader();

      reader.onload = () => {

        try {

          const result =
            String(
              reader.result || ""
            );

          const commaIndex =
            result.indexOf(",");

          if (
            commaIndex === -1
          ) {

            reject(
              new Error(
                "Unable to read payment proof."
              )
            );

            return;
          }

          const base64Data =
            result.substring(
              commaIndex + 1
            );

          if (!base64Data) {

            reject(
              new Error(
                "Payment proof is empty."
              )
            );

            return;
          }

          if (
            !file.type.startsWith("image/") ||
            file.size <= 2 * 1024 * 1024
          ) {

            resolve({
              base64Data,
              fileName: file.name,
              mimeType: file.type
            });

            return;
          }

          const image = new Image();

          image.onload = () => {

            try {

              const maxDimension = 1600;
              const scale = Math.min(
                1,
                maxDimension / Math.max(
                  image.naturalWidth,
                  image.naturalHeight
                )
              );
              const canvas = document.createElement("canvas");

              canvas.width = Math.max(
                1,
                Math.round(image.naturalWidth * scale)
              );
              canvas.height = Math.max(
                1,
                Math.round(image.naturalHeight * scale)
              );

              canvas
                .getContext("2d")
                .drawImage(
                  image,
                  0,
                  0,
                  canvas.width,
                  canvas.height
                );

              const compressed =
                canvas.toDataURL("image/jpeg", 0.82);
              const compressedCommaIndex =
                compressed.indexOf(",");

              resolve({
                base64Data:
                  compressed.substring(
                    compressedCommaIndex + 1
                  ),
                fileName:
                  file.name.replace(
                    /\.[^.]+$/,
                    ".jpg"
                  ),
                mimeType: "image/jpeg"
              });

            } catch (error) {

              reject(
                new Error(
                  "Unable to prepare payment proof."
                )
              );

            }

          };

          image.onerror = () => {

            reject(
              new Error(
                "Unable to read payment proof."
              )
            );

          };

          image.src = result;

        } catch (error) {

          reject(error);

        }

      };

      reader.onerror = () => {

        reject(
          new Error(
            "Unable to read payment proof."
          )
        );

      };

      reader.onabort = () => {

        reject(
          new Error(
            "Payment proof upload was cancelled."
          )
        );

      };

      reader.readAsDataURL(file);

    }
  );

}



async function uploadPaymentProofToSupabase(
  proof,
  groupId,
  settlementId
) {
  if (!proof || !proof.base64Data) {
    throw new Error("Payment proof is required.");
  }

  const binaryString =
    atob(proof.base64Data);

  const bytes =
    new Uint8Array(binaryString.length);

  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] =
      binaryString.charCodeAt(i);
  }

  const safeName =
    String(proof.fileName || "payment-proof")
      .replace(/[^a-zA-Z0-9._-]/g, "_");

  const extension =
    proof.mimeType === "image/jpeg"
      ? "jpg"
      : (safeName.split(".").pop() || "bin");

  const filePath =
    `${groupId}/${settlementId}/${crypto.randomUUID()}.${extension}`;

  const blob =
    new Blob(
      [bytes],
      {
        type:
          proof.mimeType ||
          "application/octet-stream"
      }
    );

  const { error } =
    await supabaseClient.storage
      .from("payment-proofs")
      .upload(
        filePath,
        blob,
        {
          contentType:
            proof.mimeType ||
            "application/octet-stream",
          upsert: false
        }
      );

  if (error) {
    throw new Error(
      error.message ||
      "Unable to upload payment proof."
    );
  }

  /*
   * The bucket is private, so store the storage path
   * rather than pretending it is a public URL.
   */
  return filePath;
}

async function submitSettlementPayment(event, settlement) {

  event.preventDefault();

  if (
    String(state.currentGroup?.group?.status).toUpperCase() ===
    "CLOSED"
  ) {
    toast("This group is closed. New payments cannot be submitted.");
    return;
  }

  try {

    const selected =
      document.querySelector(
        'input[name="settlePaymentMethod"]:checked'
      );

    if (!selected) {

      toast(
        "Please select a payment method."
      );

      return;
    }

    const paymentDetailId =
      selected.value;

    const amountInput =
      $("#settleAmountPaid");

    const amountPaid =
      Number(
        amountInput.value
      );

    const notesInput =
      $("#settlePaymentNotes");

    const notes =
      notesInput
        ? notesInput.value.trim()
        : "";

    const proofInput =
      $("#settlePaymentProof");

    const proofFile =
      proofInput &&
      proofInput.files &&
      proofInput.files.length
        ? proofInput.files[0]
        : null;


    if (
      !Number.isFinite(amountPaid) ||
      amountPaid <= 0
    ) {

      toast(
        "Please enter a valid amount paid."
      );

      return;
    }


    if (
      amountPaid >
      Number(settlement.amount) + 0.01
    ) {

      toast(
        "Amount paid cannot exceed the amount due."
      );

      return;
    }


    setLoading(
      true,
      "Checking payment..."
    );

    /*
     * Use the already-loaded group transactions instead of
     * querying payment_submissions again.
     */

    const transactions =
      (state.currentGroup?.transactions || [])
        .filter(transaction =>
          String(transaction.type || "").toUpperCase() === "PAYMENT"
        );

    const settlementPayments =
      transactions.filter(
        transaction =>
          String(transaction.settlementId) ===
            String(settlement.settlementId) &&
          String(transaction.fromUserId) ===
            String(state.user.userId)
      );

    const confirmedPaid =
      settlementPayments
        .filter(
          transaction =>
            String(transaction.status || "").toUpperCase() ===
            "CONFIRMED"
        )
        .reduce(
          (total, transaction) =>
            total + Number(transaction.amountPaid || 0),
          0
        );

    const pendingPaid =
      settlementPayments
        .filter(
          transaction =>
            String(transaction.status || "").toUpperCase() ===
            "SUBMITTED"
        )
        .reduce(
          (total, transaction) =>
            total + Number(transaction.amountPaid || 0),
          0
        );

    const settlementAmount =
      Number(settlement.amount || 0);

    const remainingAmount =
      Math.max(
        0,
        settlementAmount -
          confirmedPaid -
          pendingPaid
      );

    if (
      amountPaid >
      remainingAmount + 0.01
    ) {
      toast(
        `Amount paid cannot exceed the remaining balance of ${formatMoney(
          remainingAmount
        )}.`
      );
      return;
    }

    /*
     * --------------------------------------------------
     * NEW PAYMENT
     * --------------------------------------------------
     */

    let proofFileUrl = "";

    if (proofFile) {
      setLoading(
        true,
        "Preparing payment proof..."
      );

      const proof =
        await preparePaymentProof(
          proofFile
        );

      setLoading(
        true,
        "Uploading payment proof..."
      );

      proofFileUrl =
        await uploadPaymentProofToSupabase(
          proof,
          settlement.groupId,
          settlement.settlementId
        );
    }


    /*
     * --------------------------------------------------
     * SUBMIT PAYMENT
     * --------------------------------------------------
     */

    setLoading(
      true,
      "Submitting payment..."
    );


    const { error: submissionError } =
      await supabaseClient
        .from("payment_submissions")
        .insert({
          settlement_id: settlement.settlementId,
          group_id: settlement.groupId,
          payer_user_id: state.user.userId,
          recipient_user_id: settlement.toUserId,
          payment_option:
            selected.dataset?.paymentOption ||
            selected.value,
          payment_detail_id: paymentDetailId,
          amount_due: Number(settlement.amount),
          amount_paid: amountPaid,
          proof_file_url: proofFileUrl || null,
          notes: notes || "",
          status: "SUBMITTED"
        });

    if (submissionError) {
      throw submissionError;
    }

    /*
     * The settlement returned by the balance calculation is
     * already the source record for this payment. Do not create
     * a second settlement row here.
     */


    if (
      window.owemeSettlementDrafts &&
      window.owemeSettlementDrafts[
        settlement.settlementId
      ]
    ) {

      delete window.owemeSettlementDrafts[
        settlement.settlementId
      ];

    }


    /*
     * IMPORTANT:
     * Refresh the entire group after the payment
     * has been successfully saved.
     *
     * This reloads:
     * - balances
     * - settlements
     * - transactions
     *
     * so the new payment appears immediately
     * in the Transactions section.
     */

    closeModal();

    await new Promise(resolve =>
      requestAnimationFrame(resolve)
    );

    await refreshCurrentGroup();


    toast(
      "Payment submitted for confirmation."
    );


  } catch (error) {

    console.error(
      "SUBMIT PAYMENT ERROR:",
      error
    );


    toast(
      error &&
      error.message
        ? error.message
        : "Something went wrong. Please try again."
    );


  } finally {

    setLoading(false);

  }

}

async function markSettlementPaid(settlementId) {

  if (!confirm("Mark this settlement as paid?")) {
    return;
  }

  try {

    setLoading(true, "Saving settlement...");

    const settlementResult =
      await getSettlementsFromSupabase(
        state.currentGroup.group.groupId
      );

    const settlements =
      settlementResult.settlements ||
      settlementResult.data?.settlements ||
      [];

    const settlement =
      settlements.find(
        item => item.settlementId === settlementId
      );

    if (!settlement) {
      toast("Settlement not found.");
      return;
    }

    const { error: settlementError } =
      await supabaseClient
        .from("settlements")
        .update({
          status: "PAID",
          paid_at: new Date().toISOString()
        })
        .eq("id", settlement.settlementId)
        .eq("group_id", settlement.groupId);

    if (settlementError) {
      throw settlementError;
    }

    toast("Settlement marked as paid.");

    await openSettlementsModal();

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }
}


/* =========================================================
   MEMBERS
   ========================================================= */

async function loadContactSuggestions() {

  /*
   * Add Members should search all existing OweMe users,
   * not only people who already share a group with you.
   */
  const currentUserId =
    String(state.user.userId);

  const {
    data: profiles,
    error
  } = await supabaseClient
    .from("profiles")
    .select(
      "id, username, username_normalized, display_name, status"
    )
    .neq(
      "id",
      currentUserId
    )
    .eq(
      "status",
      "ACTIVE"
    )
    .order(
      "username_normalized",
      {
        ascending: true
      }
    );

  if (error) {
    throw error;
  }

  return (profiles || [])
    .filter(profile =>
      profile.username
    )
    .map(profile => ({
      userId:
        String(profile.id),

      username:
        profile.username,

      displayName:
        profile.display_name || "",

      sharedGroups: []
    }));

}

async function openMembersModal() {

  const members =
    state.currentGroup.members || [];

  openModal(`

    <h2>Members</h2>

    <div class="card members-list-card">

      ${members.map(member => `

        <div class="member-row">

          <div class="member-identity">

            <span class="member-display-name">
              ${escapeHtml(member.displayName || "Member")}
            </span>

          </div>

          <small class="member-role">
            ${escapeHtml(String(member.role).toLowerCase().replace(/^\w/, c => c.toUpperCase()))}
          </small>

        </div>

      `).join("")}

    </div>

    <div class="section-title">
      Add members
    </div>

    <form id="inviteMemberForm">

      <div class="contacts-search invite-contacts-search">

        <input
          type="search"
          id="inviteMemberSearch"
          placeholder="Search OweMe users by username..."
          autocomplete="off"
        >

      </div>

      <div
        id="inviteMemberSuggestions"
        class="invite-contact-suggestions"
      ></div>

      <div class="selected-members-title">
        Selected members
      </div>

      <div
        id="inviteSelectedMembers"
        class="selected-members-list"
      ></div>

      <input
        type="hidden"
        id="inviteMemberUsernames"
      >

      <button
        class="primary-button"
        type="submit"
      >
        Send Invitation
      </button>

    </form>

  `);

  const searchInput =
    $("#inviteMemberSearch");

  const suggestions =
    $("#inviteMemberSuggestions");

  const selectedList =
    $("#inviteSelectedMembers");

  const hiddenUsernames =
    $("#inviteMemberUsernames");

  const selectedMembers = [];

  let contacts = [];

  try {

    contacts =
      await loadContactSuggestions();

  } catch (error) {

    console.error(
      "LOAD MEMBER CONTACTS ERROR:",
      error
    );

  }

  function syncSelectedMembers() {

    hiddenUsernames.value =
      selectedMembers
        .map(member => member.username)
        .join("\n");

  }

  function renderSelectedMembers() {

    if (!selectedMembers.length) {

      selectedList.innerHTML = `
        <div class="selected-members-empty">
          No members selected yet.
        </div>
      `;

      syncSelectedMembers();

      return;
    }

    selectedList.innerHTML =
      selectedMembers.map(member => `

        <div
          class="selected-member-row"
          data-selected-user-id="${escapeHtml(String(member.userId))}"
        >

          <div>

            <div class="user-name">
              ${escapeHtml(member.displayName || "Member")}
            </div>

          </div>

          <button
            type="button"
            class="selected-member-remove"
            data-remove-user-id="${escapeHtml(String(member.userId))}"
            aria-label="Remove ${escapeHtml(member.username)}"
          >
            ×
          </button>

        </div>

      `).join("");

    selectedList
      .querySelectorAll(
        ".selected-member-remove"
      )
      .forEach(button => {

        button.addEventListener(
          "click",
          () => {

            const userId =
              String(
                button.dataset.removeUserId || ""
              );

            const index =
              selectedMembers.findIndex(
                member =>
                  String(member.userId) === userId
              );

            if (index !== -1) {
              selectedMembers.splice(index, 1);
            }

            renderSelectedMembers();

            renderMemberSuggestions(
              searchInput.value
            );

          }
        );

      });

    syncSelectedMembers();

  }

  function addSelectedMember(member) {

    const userId =
      String(member.userId);

    const username =
      String(member.username || "")
        .trim()
        .replace(/^@/, "");

    if (!username) {
      return;
    }

    const alreadySelected =
      selectedMembers.some(
        selected =>
          String(selected.userId) === userId ||
          String(selected.username).toLowerCase() ===
            username.toLowerCase()
      );

    if (alreadySelected) {
      toast("That member is already selected.");
      return;
    }

    selectedMembers.push({
      userId,
      username,
      displayName:
        member.displayName || ""
    });

    searchInput.value = "";

    suggestions.innerHTML = "";

    renderSelectedMembers();

    searchInput.focus();

  }

  function renderMemberSuggestions(query = "") {

    const normalizedQuery =
      String(query || "")
        .trim()
        .replace(/^@/, "")
        .toLowerCase();

    if (!normalizedQuery) {

      suggestions.innerHTML = "";

      return;
    }

    const selectedUserIds =
      new Set(
        selectedMembers.map(member =>
          String(member.userId)
        )
      );

    const selectedUsernames =
      new Set(
        selectedMembers.map(member =>
          String(member.username).toLowerCase()
        )
      );

    const filtered =
      contacts.filter(contact => {

        const userId =
          String(contact.userId);

        const username =
          String(contact.username || "")
            .toLowerCase();

        if (
          selectedUserIds.has(userId) ||
          selectedUsernames.has(username)
        ) {
          return false;
        }

        return (
          username.includes(normalizedQuery) ||
          String(contact.displayName || "")
            .toLowerCase()
            .includes(normalizedQuery)
        );

      });

    suggestions.innerHTML =
      filtered.length
        ? filtered.map(contact => `

            <button
              type="button"
              class="invite-contact-suggestion"
              data-contact-user-id="${escapeHtml(String(contact.userId))}"
            >

              <span>

                <strong>
                  ${escapeHtml(contact.displayName || "Member")}
                </strong>

              </span>

              <small class="muted">
                @${escapeHtml(contact.username)}
              </small>

            </button>

          `).join("")
        : `
            <div class="invite-contact-empty">
              No OweMe user found with that username.
            </div>
          `;

    suggestions
      .querySelectorAll(
        ".invite-contact-suggestion"
      )
      .forEach(button => {

        button.addEventListener(
          "click",
          () => {

            const userId =
              String(
                button.dataset.contactUserId || ""
              );

            const contact =
              contacts.find(
                item =>
                  String(item.userId) === userId
              );

            if (contact) {
              addSelectedMember(contact);
            }

          }
        );

      });

  }

  searchInput.addEventListener(
    "input",
    event => {

      renderMemberSuggestions(
        event.target.value
      );

    }
  );

  searchInput.addEventListener(
    "keydown",
    event => {

      if (
        event.key === "Enter" &&
        String(searchInput.value || "").trim()
      ) {

        event.preventDefault();

        const query =
          String(searchInput.value || "")
            .trim()
            .replace(/^@/, "")
            .toLowerCase();

        const exactContact =
          contacts.find(contact =>
            String(contact.username || "")
              .toLowerCase() === query
          );

        if (exactContact) {

          addSelectedMember(exactContact);

        } else {

          toast(
            "No OweMe user found with that username."
          );

        }

      }

    }
  );

  renderSelectedMembers();

  $("#inviteMemberForm").addEventListener(
    "submit",
    inviteMember
  );

}


async function inviteMember(event) {

  event.preventDefault();

  const rawUsernames =
    String(
      $("#inviteMemberUsernames")?.value || ""
    );

  const usernames =
    [...new Set(
      rawUsernames
        .split("\n")
        .map(username =>
          username.trim().replace(/^@/, "")
        )
        .filter(Boolean)
        .map(username =>
          username.toLowerCase()
        )
    )];

  if (!usernames.length) {
    toast("Please select at least one member.");
    return;
  }

  try {

    setLoading(true, "Sending invitations...");

    const {
      data: {
        user
      },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error(
        "Your session has expired. Please log in again."
      );
    }

    /* ================================================
       1. FIND ALL INVITED USERS
       ================================================ */

    const {
      data: invitedProfiles,
      error: profileError
    } = await supabaseClient
      .from("profiles")
      .select(
        "id, username, username_normalized"
      )
      .in(
        "username_normalized",
        usernames
      );

    if (profileError) {
      throw profileError;
    }

    const profiles =
      invitedProfiles || [];

    if (!profiles.length) {
      throw new Error(
        "None of the selected usernames were found."
      );
    }

    /* ================================================
       2. VALIDATE ALL USERS
       ================================================ */

    const invitations = [];
    const skipped = [];

    for (const profile of profiles) {

      if (String(profile.id) === String(user.id)) {
        skipped.push(profile.username);
        continue;
      }

      const {
        data: existingMember,
        error: memberError
      } = await supabaseClient
        .from("group_members")
        .select("user_id")
        .eq(
          "group_id",
          state.currentGroup.group.groupId
        )
        .eq(
          "user_id",
          profile.id
        )
        .eq(
          "status",
          "ACTIVE"
        )
        .maybeSingle();

      if (memberError) {
        throw memberError;
      }

      if (existingMember) {
        skipped.push(profile.username);
        continue;
      }

      const {
        data: existingInvitation,
        error: existingInvitationError
      } = await supabaseClient
        .from("invitations")
        .select("id")
        .eq(
          "group_id",
          state.currentGroup.group.groupId
        )
        .eq(
          "invited_user_id",
          profile.id
        )
        .eq(
          "status",
          "PENDING"
        )
        .maybeSingle();

      if (existingInvitationError) {
        throw existingInvitationError;
      }

      if (existingInvitation) {
        skipped.push(profile.username);
        continue;
      }

      invitations.push({
        group_id:
          state.currentGroup.group.groupId,

        invited_user_id:
          profile.id,

        invited_by_user_id:
          user.id,

        status:
          "PENDING"
      });

    }

    /* ================================================
       3. CREATE ALL INVITATIONS
       ================================================ */

    if (!invitations.length) {

      throw new Error(
        "No new invitations could be sent. The selected users may already be members or have pending invitations."
      );

    }

    const {
      error: invitationError
    } = await supabaseClient
      .from("invitations")
      .insert(invitations);

    if (invitationError) {
      throw invitationError;
    }

    closeModal();

    const sentCount =
      invitations.length;

    toast(
      sentCount === 1
        ? "Invitation sent."
        : `${sentCount} invitations sent.`
    );

  } catch (error) {

    console.error(
      "INVITE MEMBERS ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to send invitations."
    );

  } finally {

    setLoading(false);

  }
}



/* =========================================================
   INVITATIONS
   ========================================================= */

async function loadInvitations() {

  $("#pageTitle").textContent = "Invites";

  const { data: invitationRows, error } =
    await supabaseClient
      .from("invitations")
      .select(`
        id,
        group_id,
        invited_user_id,
        invited_by_user_id,
        status,
        created_at,
        responded_at,
        groups (
          id,
          group_name
        )
      `)
      .eq("invited_user_id", state.user.userId)
      .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const invitations = invitationRows || [];
  const inviterMap = {};

  /*
   * Resolve each inviter through the dedicated profile RPC.
   * The invited user is not an active group member yet,
   * so get_group_members() cannot be used here.
   */
  for (const invitation of invitations) {

    if (!invitation.invited_by_user_id) continue;

    const { data: profileRows, error: profileError } =
      await supabaseClient.rpc(
        "get_profile_by_id",
        {
          lookup_user_id: invitation.invited_by_user_id
        }
      );

    if (profileError) {
      console.error(
        "LOAD INVITER PROFILE ERROR:",
        profileError
      );
      continue;
    }

    const profile = profileRows?.[0];

    if (profile) {
      inviterMap[String(invitation.invited_by_user_id)] = {
        username: profile.username || "",
        displayName: profile.display_name || ""
      };
    }
  }

  state.invitations =
    invitations.map(invitation => {
      const inviter =
        inviterMap[String(invitation.invited_by_user_id)] || {};

      return {
        invitationId: invitation.id,
        groupId: invitation.group_id,
        invitedUserId: invitation.invited_user_id,
        invitedByUserId: invitation.invited_by_user_id,
        status: invitation.status,
        createdAt: invitation.created_at,
        respondedAt: invitation.responded_at,
        groupName: invitation.groups?.group_name || "Group",
        invitedByUsername:
          inviter.username || "",
        invitedByDisplayName:
          inviter.displayName || ""
      };
    });

  if (!document.getElementById("invitesTabContent")) {
    $("#content").innerHTML = `
      ${renderInvitesTabs()}
      <div id="invitesTabContent"></div>
    `;
  }

  $("#invitesTabContent").innerHTML = `

    <div class="history-intro page-intro">
      <h2>Your invitations</h2>
      <p>Group invitations waiting for your response.</p>
    </div>

    ${
      state.invitations.length
      ? state.invitations.map(renderInvitation).join("")
      : `
        <div class="card empty">
          You have no pending invitations.
        </div>
      `
    }

  `;
}


function renderInvitation(invitation) {

  const status =
    String(invitation.status || "").toUpperCase();

  const actions =
    status === "PENDING"
      ? `
        <div class="invitation-icon-actions">

          <button
            type="button"
            class="invitation-icon-button invitation-accept-button"
            aria-label="Accept invitation"
            title="Accept invitation"
            onclick="event.stopPropagation(); respondInvitation(
              '${escapeHtml(invitation.invitationId)}',
              'accept'
            )"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M5 12.5l4 4L19 6.5"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>

          <button
            type="button"
            class="invitation-icon-button invitation-decline-button"
            aria-label="Decline invitation"
            title="Decline invitation"
            onclick="event.stopPropagation(); respondInvitation(
              '${escapeHtml(invitation.invitationId)}',
              'decline'
            )"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
          </button>

        </div>
      `
      : `
        <div
          class="invitation-status ${
            status === "ACCEPTED"
              ? "accepted"
              : "declined"
          }"
        >
          ${
            status === "ACCEPTED"
              ? "Invitation Accepted"
              : "Invitation Declined"
          }
        </div>
      `;

  return `

    <div class="invitation-list-item">

      <div class="invitation-list-info">

        <div class="invitation-list-title">
          ${escapeHtml(invitation.groupName)}
        </div>

        <div class="invitation-list-meta">
          Invited by
          ${escapeHtml(invitation.invitedByDisplayName || invitation.invitedByUsername || "Unknown")}
        </div>

      </div>

      <div class="invitation-list-actions">
        ${actions}
      </div>

    </div>

  `;
}


async function respondInvitation(
  invitationId,
  action
) {

  try {

    setLoading(
      true,
      action === "accept"
        ? "Joining group..."
        : "Declining..."
    );

    if (action === "accept") {
      const {
        data: invitation,
        error: invitationError
      } = await supabaseClient
        .from("invitations")
        .select("*")
        .eq("id", invitationId)
        .eq("invited_user_id", state.user.userId)
        .eq("status", "PENDING")
        .single();

      if (invitationError || !invitation) {
        throw invitationError ||
          new Error("Invitation not found or already handled.");
      }

      const { error: memberError } =
        await supabaseClient
          .from("group_members")
          .insert({
            group_id: invitation.group_id,
            user_id: state.user.userId,
            role: "MEMBER",
            status: "ACTIVE"
          });

      if (memberError) {
        throw memberError;
      }

      const { error: updateInvitationError } =
        await supabaseClient
          .from("invitations")
          .update({
            status: "ACCEPTED",
            responded_at: new Date().toISOString()
          })
          .eq("id", invitationId)
          .eq("invited_user_id", state.user.userId);

      if (updateInvitationError) {
        throw updateInvitationError;
      }

    } else {

      const { error } = await supabaseClient
        .from("invitations")
        .update({
          status: "DECLINED",
          responded_at: new Date().toISOString()
        })
        .eq("id", invitationId)
        .eq("invited_user_id", state.user.userId)
        .eq("status", "PENDING");

      if (error) {
        throw error;
      }
    }

    await loadInvitations();

    toast(
      action === "accept"
        ? "You're now a group member."
        : "Invitation declined."
    );

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }
}


/* =========================================================
   PROFILE
   ========================================================= */

async function loadPaymentProviders() {

  const { data, error } = await supabaseClient
    .from("payment_providers")
    .select("*")
    .eq("status", "ACTIVE")
    .order("sort_order").order("provider_name");

  if (error) {
    throw error;
  }

  return data || [];
}


async function loadPaymentDetails() {

  const { data, error } = await supabaseClient
    .from("payment_details")
    .select("*")
    .eq("user_id", state.user.userId)
    .eq("status", "ACTIVE")
    .order("is_preferred", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data || []).map(detail => ({
    paymentDetailId: detail.id,
    userId: detail.user_id,
    paymentOption: detail.payment_option,
    accountNumber: detail.account_number,
    accountName: detail.account_name,
    qrFileUrl: detail.qr_file_url,
    isPreferred: detail.is_preferred,
    status: detail.status,
    createdAt: detail.created_at,
    updatedAt: detail.updated_at
  }));
}


async function renderProfile() {

  try {

    $("#pageTitle").textContent = "Profile";

    $("#content").innerHTML = `

      <div class="history-intro page-intro">
        <h2>Your profile</h2>
        <p>Manage your account and payment details.</p>
      </div>

      <div class="card profile-account-card">

        <div class="card-title">
          My Account
        </div>

        <div class="profile-account-details">

          <div>
            <strong>Display Name:</strong>
            ${escapeHtml(state.user.displayName || "Member")}
          </div>

          <div>
            <strong>Email:</strong>
            ${escapeHtml(state.user.email)}
          </div>

        </div>

        <div class="profile-account-actions">

          <button
            class="secondary-button"
            type="button"
            id="editDisplayNameButton"
          >
            Edit Display Name
          </button>

          <button
            class="secondary-button"
            type="button"
            id="changePasswordButton"
          >
            Change Password
          </button>

        </div>

      </div>


      <div class="card">

        <div class="card-title">
          Payment Details
        </div>

        <p class="muted">
          Add payment details so other group members can easily pay you.
        </p>

        <div id="paymentDetailsList">

          <div class="muted">
            Loading payment details...
          </div>

        </div>

        <button
          class="primary-button"
          type="button"
          id="addPaymentDetailsButton"
          style="margin-top:16px"
        >
          + Add Payment Details
        </button>

      </div>


      <div class="card">

        <div class="card-title">
          Notifications
        </div>

        <p class="muted">
          Test browser and PWA notification setup.
        </p>

        <button
          class="secondary-button"
          type="button"
          id="testPwaNotificationsButton"
        >
          🔔 Test PWA Notifications
        </button>

        <button
          class="secondary-button"
          type="button"
          id="testLocalNotificationButton"
        >
          📨 Test Local Notification
        </button>

      </div>


      <div class="card">

        <button
          class="danger-button"
          onclick="logout()"
        >
          Log Out
        </button>

      </div>

    `;


    $("#editDisplayNameButton").addEventListener(
      "click",
      openEditDisplayNameModal
    );


    $("#changePasswordButton").addEventListener(
      "click",
      openChangePasswordModal
    );


    $("#addPaymentDetailsButton").addEventListener(
      "click",
      openPaymentDetailsForm
    );

    $("#testPwaNotificationsButton").addEventListener(
      "click",
      runWebPushDiagnostics
    );

    const testLocalNotificationButton =
      $("#testLocalNotificationButton");

    if (testLocalNotificationButton) {
      testLocalNotificationButton.addEventListener(
        "click",
        async () => {
          alert("OweMe local notification test button was clicked.");

          try {
            const registration =
              await navigator.serviceWorker.ready;

            await registration.showNotification(
              "OweMe Test",
              {
                body: "Local service-worker notification is working! 🔔",
                tag: "oweme-local-test"
              }
            );
          } catch (error) {
            alert(
              "Local notification failed: " +
              (error?.message || error)
            );
          }
        }
      );
    }


    try {

      await renderSavedPaymentDetails();

    } catch (error) {

      console.error(
        "LOAD PAYMENT DETAILS ERROR:",
        error
      );

      const container =
        $("#paymentDetailsList");

      if (container) {

        container.innerHTML = `
          <div class="muted">
            No payment details added yet.
          </div>
        `;

      }

    }

  } catch (error) {

    console.error(
      "PROFILE RENDER ERROR:",
      error
    );

    $("#content").innerHTML = `
      <div class="card">
        <div class="card-title">
          Profile Error
        </div>

        <p class="muted">
          ${escapeHtml(error.message || String(error))}
        </p>
      </div>
    `;

    throw error;

  }

}


function openEditDisplayNameModal() {

  openModal(`

    <h2>Edit Display Name</h2>

    <form id="profileForm">

      <label>
        Display Name

        <input
          id="profileDisplayName"
          value="${escapeHtml(state.user.displayName)}"
          maxlength="50"
          required
        >

      </label>

      <button
        class="primary-button"
        type="submit"
      >
        Save Changes
      </button>

    </form>

  `);


  $("#profileForm").addEventListener(
    "submit",
    updateProfile
  );

}


function openChangePasswordModal() {

  openModal(`

    <h2>Change Password</h2>

    <form id="passwordForm">

      <label>
        Current password

        <input
          id="currentPassword"
          type="password"
          required
        >

      </label>

      <label>
        New password

        <input
          id="newPassword"
          type="password"
          minlength="8"
          required
        >

      </label>

      <label>
        Confirm new password

        <input
          id="confirmNewPassword"
          type="password"
          minlength="8"
          required
        >

      </label>

      <button
        class="primary-button"
        type="submit"
      >
        Change Password
      </button>

    </form>

  `);


  $("#passwordForm").addEventListener(
    "submit",
    changePassword
  );

}

function openPaymentDetailsForm() {

  loadPaymentProviders()
    .then(providers => {

      const options = providers
        .map(provider => `
          <option
            value="${escapeHtml(provider.provider_name)}"
          >
            ${escapeHtml(provider.provider_name)}
          </option>
        `)
        .join("");

      openModal(`

        <h2>Payment Details</h2>

        <p class="muted">
          Add a payment option so other group members
          can easily pay you.
        </p>

        <form id="paymentDetailsForm">

          <label>
            Payment Option

            <select
              id="paymentOption"
              required
            >
              <option value="">
                Select payment option
              </option>

              ${options}

            </select>

          </label>


          <div id="paymentAccountFields">

            <label>
              Account Number / Mobile Number

              <input
                id="paymentAccountNumber"
                type="text"
                autocomplete="off"
              >

            </label>


            <label>
              Account Name

              <input
                id="paymentAccountName"
                type="text"
                maxlength="100"
                autocomplete="off"
              >

            </label>


            <label id="paymentQrGroup">

              QR Code

              <input
                id="paymentQrFile"
                type="file"
                accept="image/png,image/jpeg,image/webp"
              >

              <div class="muted">
                Optional. Upload your payment QR code.
              </div>

            </label>

          </div>


          <label
            style="
              display:flex;
              align-items:center;
              gap:8px;
              margin-top:12px;
            "
          >

            <input
              id="paymentIsPreferred"
              type="checkbox"
              style="width:auto"
            >

            <span>
              Set as preferred payment option
            </span>

          </label>


          <button
            class="primary-button"
            type="submit"
            style="margin-top:16px"
          >
            Save Payment Details
          </button>

        </form>

      `);


      $("#paymentOption")
        .addEventListener(
          "change",
          updatePaymentOptionFields
        );


      $("#paymentDetailsForm")
        .addEventListener(
          "submit",
          savePaymentDetails
        );

      updatePaymentOptionFields();

    })
    .catch(error => {

      toast(error.message);

    })
    .finally(() => {

      setLoading(false);

    });

}

function updatePaymentOptionFields() {

  const paymentOption =
    $("#paymentOption").value;

  const fields =
    $("#paymentAccountFields");

  const qrGroup =
    $("#paymentQrGroup");

  const accountNumber =
    $("#paymentAccountNumber");

  const accountName =
    $("#paymentAccountName");


  const isCash =
    paymentOption === "Cash";


  fields.classList.toggle(
    "hidden",
    isCash
  );


  if (qrGroup) {

    qrGroup.classList.toggle(
      "hidden",
      isCash
    );

  }


  accountNumber.required =
    !isCash;

  accountName.required =
    !isCash;


  if (isCash) {

    accountNumber.value = "";
    accountName.value = "";

    const qrFile =
      $("#paymentQrFile");

    if (qrFile) {
      qrFile.value = "";
    }

  }

}

async function getPaymentQrUrl(storagePath) {
  if (!storagePath) {
    return "";
  }

  const { data, error } = await supabaseClient.storage
    .from("payment-proofs")
    .createSignedUrl(storagePath, 3600);

  if (error) {
    console.error("PAYMENT QR URL ERROR:", error);
    return "";
  }

  return data?.signedUrl || "";
}


async function renderSavedPaymentDetails() {

  const container =
    $("#paymentDetailsList");

  if (!container) {
    return;
  }


  try {

    const details =
      await loadPaymentDetails();


    if (!details.length) {

      container.innerHTML = `
        <div class="muted">
          No payment details added yet.
        </div>
      `;

      return;
    }


    const detailsWithQrUrls = await Promise.all(
      details.map(async detail => ({
        ...detail,
        qrDisplayUrl: detail.qrDisplayUrl
          ? await getPaymentQrUrl(detail.qrDisplayUrl)
          : ""
      }))
    );


    container.innerHTML =
      detailsWithQrUrls
        .map(detail => `

          <div
            class="card payment-detail-card"
          >

            <div class="payment-detail-content">

              <div class="payment-detail-info">

                <div class="payment-detail-row">
                  <strong>Payment Method:</strong>
                  <span>${escapeHtml(detail.paymentOption)}</span>
                </div>

                ${
                  detail.paymentOption === "Cash"
                    ? `
                      <div class="payment-detail-row">
                        <strong>Account Name:</strong>
                        <span>Cash payment</span>
                      </div>
                    `
                    : `
                      <div class="payment-detail-row">
                        <strong>Account Name:</strong>
                        <span>${escapeHtml(detail.accountName)}</span>
                      </div>

                      <div class="payment-detail-row">
                        <strong>Account Number:</strong>
                        <span>${escapeHtml(detail.accountNumber)}</span>
                      </div>
                    `
                }

                ${
                  detail.qrDisplayUrl
                    ? `
                      <div class="payment-detail-qr">

                        <div class="muted payment-detail-qr-label">
                          Payment QR Code
                        </div>

                        <a
                          href="${escapeHtml(detail.qrDisplayUrl)}"
                          target="_blank"
                          rel="noopener noreferrer"
                        >

                          <img
                            src="${escapeHtml(detail.qrDisplayUrl)}"
                            alt="Payment QR Code"
                            class="payment-detail-qr-image"
                          >

                        </a>

                        <a
                          href="${escapeHtml(detail.qrDisplayUrl)}"
                          target="_blank"
                          rel="noopener noreferrer"
                          class="secondary-button payment-detail-qr-button"
                          style="text-decoration:none;"
                        >
                          View QR Code
                        </a>

                      </div>
                    `
                    : ""
                }

              </div>


              <div class="payment-detail-actions">

                <div class="payment-detail-action-buttons">

                  ${
                    detail.qrFileUrl
                      ? `
                        <button
                          type="button"
                          class="secondary-button payment-detail-button"
                          onclick="viewPaymentQr('${detail.paymentDetailId}')"
                          aria-label="View QR Code"
                          title="View QR Code"
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            />
                            <circle
                              cx="12"
                              cy="12"
                              r="3"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                            />
                          </svg>
                        </button>
                      `
                      : ""
                  }

                  <button
                    type="button"
                    class="secondary-button payment-detail-button"
                    onclick="editPaymentDetails('${detail.paymentDetailId}')"
                    aria-label="Edit Payment Details"
                    title="Edit Payment Details"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d="M12 20h9"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                      />
                      <path
                        d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </button>

                  <button
                    type="button"
                    class="danger-button payment-detail-button"
                    onclick="deletePaymentDetails('${detail.paymentDetailId}')"
                    aria-label="Delete Payment Details"
                    title="Delete Payment Details"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d="M3 6h18"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                      />
                      <path
                        d="M8 6V4h8v2"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                      <path
                        d="M19 6l-1 14H6L5 6"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                      <path
                        d="M10 11v5M14 11v5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                      />
                    </svg>
                  </button>

                </div>

                <button
                  type="button"
                  class="secondary-button payment-detail-payme-button"
                  onclick="createPayMeLink('${detail.paymentDetailId}')"
                >
                  Create PayMe Link →
                </button>

              </div>

            </div>

          </div>

        `)
        .join("");


  } catch (error) {

    container.innerHTML = `
      <div class="muted">
        Unable to load payment details.
      </div>
    `;

  }

}

async function viewPaymentQr(paymentDetailId) {
  try {
    setLoading(true, "Opening QR code...");

    const details = await loadPaymentDetails();

    const detail = details.find(
      item => String(item.paymentDetailId) === String(paymentDetailId)
    );

    if (!detail || !detail.qrFileUrl) {
      throw new Error("No QR code was uploaded for this payment method.");
    }

    const signedUrl = await getPaymentQrUrl(detail.qrFileUrl);

    if (!signedUrl) {
      throw new Error("Unable to open the QR code.");
    }

    openModal(`
      <div class="payment-qr-modal">
        <h2>${escapeHtml(detail.paymentOption)} QR Code</h2>

        <p class="muted">
          ${escapeHtml(detail.accountName || "")}
        </p>

        <img
          src="${escapeHtml(signedUrl)}"
          alt="Payment QR Code"
          class="payment-qr-image"
        >
      </div>
    `);
  } catch (error) {
    console.error("VIEW PAYMENT QR ERROR:", error);
    toast(error.message || "Unable to open the QR code.");
  } finally {
    setLoading(false);
  }
}


async function editPaymentDetails(paymentDetailId) {

  setLoading(true, "Loading payment details...");

  try {

    const details =
      await loadPaymentDetails();

    const detail =
      details.find(
        item =>
          String(item.paymentDetailId) ===
          String(paymentDetailId)
      );

    if (!detail) {
      toast("Payment details not found.");
      return;
    }


    const providers =
      await loadPaymentProviders();

    const options =
      providers
        .map(provider => `
          <option
            value="${escapeHtml(provider.provider_name)}"
            ${
              provider.provider_name === detail.paymentOption
                ? "selected"
                : ""
            }
          >
            ${escapeHtml(provider.provider_name)}
          </option>
        `)
        .join("");


    openModal(`

      <h2>Edit Payment Details</h2>

      <p class="muted">
        Update your payment information.
      </p>

      <form id="paymentDetailsEditForm">

        <label>
          Payment Option

          <select
            id="paymentOption"
            required
          >

            <option value="">
              Select payment option
            </option>

            ${options}

          </select>

        </label>


        <div id="paymentAccountFields">

          <label>
            Account Number / Mobile Number

            <input
              id="paymentAccountNumber"
              type="text"
              autocomplete="off"
              value="${escapeHtml(detail.accountNumber || "")}"
            >

          </label>


          <label>
            Account Name

            <input
              id="paymentAccountName"
              type="text"
              maxlength="100"
              autocomplete="off"
              value="${escapeHtml(detail.accountName || "")}"
            >

          </label>


          <label id="paymentQrGroup">

            QR Code

            <input
              id="paymentQrFile"
              type="file"
              accept="image/png,image/jpeg,image/webp"
            >

            <div class="muted">
              Optional. Upload a new QR code to replace the current one.
            </div>

          </label>

        </div>


        <label
          style="
            display:flex;
            align-items:center;
            gap:8px;
            margin-top:12px;
          "
        >

          <input
            id="paymentIsPreferred"
            type="checkbox"
            style="width:auto"
            ${detail.isPreferred ? "checked" : ""}
          >

          <span>
            Set as preferred payment option
          </span>

        </label>


        <button
          class="primary-button"
          type="submit"
          style="margin-top:16px"
        >
          Update Payment Details
        </button>

      </form>

    `);


    $("#paymentOption")
      .addEventListener(
        "change",
        updatePaymentOptionFields
      );


    $("#paymentDetailsEditForm")
      .addEventListener(
        "submit",
        event =>
          updatePaymentDetails(
            event,
            paymentDetailId
          )
      );


    updatePaymentOptionFields();

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);
  }

}


async function updatePaymentDetails(event, paymentDetailId) { event.preventDefault(); const paymentOption=$("#paymentOption").value.trim(); const accountNumber=$("#paymentAccountNumber").value.trim(); const accountName=$("#paymentAccountName").value.trim(); const isPreferred=$("#paymentIsPreferred").checked; const qrInput=$("#paymentQrFile"); const qrFile=qrInput&&qrInput.files&&qrInput.files.length?qrInput.files[0]:null; if(!paymentOption){toast("Please select a payment option.");return;} if(paymentOption!=="Cash"&&(!accountNumber||!accountName)){toast("Please enter the account number and account name.");return;} try{setLoading(true,"Updating payment details..."); let qrFileUrl=""; if(paymentOption!=="Cash"&&qrFile){setLoading(true,"Preparing QR code..."); const qr=await preparePaymentProof(qrFile); setLoading(true,"Uploading QR code..."); const uploadResult = await uploadPaymentProofToSupabase(
        qr,
        state.user.userId,
        crypto.randomUUID()
      ); qrFileUrl = uploadResult || ""; if(!qrFileUrl)throw new Error("QR code uploaded, but no file path was returned.");} const payload={paymentDetailId,paymentOption,accountNumber,accountName,isPreferred}; if(qrFileUrl)payload.qrFileUrl=qrFileUrl; const { error: updateError } = await supabaseClient
        .from("payment_details")
        .update({
          payment_option: payload.paymentOption,
          account_number: payload.accountNumber,
          account_name: payload.accountName,
          ...(payload.qrFileUrl
            ? { qr_file_url: payload.qrFileUrl }
            : {}),
          is_preferred: payload.isPreferred,
          updated_at: new Date().toISOString()
        })
        .eq("id", paymentDetailId)
        .eq("user_id", state.user.userId);

      if (updateError) {
        throw updateError;
      } closeModal(); await renderSavedPaymentDetails(); toast("Payment details updated.");}catch(error){console.error("UPDATE PAYMENT DETAILS ERROR:",error);toast(error&&error.message?error.message:"Something went wrong. Please try again.");}finally{setLoading(false);}}

async function deletePaymentDetails(
  paymentDetailId
) {

  openModal(`

    <div class="modal-confirmation">

      <h2>Delete Payment Method?</h2>

      <p class="muted">
        This payment method will be removed from
        your active payment options.
      </p>

      <div
        style="
          display:flex;
          justify-content:flex-end;
          gap:10px;
          margin-top:20px;
        "
      >

        <button
          type="button"
          class="secondary-button"
          onclick="closeModal()"
        >
          Cancel
        </button>

        <button
          type="button"
          class="danger-button"
          onclick="confirmDeletePaymentDetails('${paymentDetailId}')"
        >
          Delete
        </button>

      </div>

    </div>

  `);

}


async function confirmDeletePaymentDetails(
  paymentDetailId
) {

  try {

    setLoading(
      true,
      "Deleting payment details..."
    );

    const { error } = await supabaseClient
      .from("payment_details")
      .update({
        status: "DELETED",
        updated_at: new Date().toISOString()
      })
      .eq("id", paymentDetailId)
      .eq("user_id", state.user.userId);

    if (error) {
      throw error;
    }

    closeModal();

    await renderSavedPaymentDetails();

    toast(
      "Payment method deleted."
    );

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }

}

async function savePaymentDetails(event) { event.preventDefault(); const paymentOption=$("#paymentOption").value.trim(); const accountNumber=$("#paymentAccountNumber").value.trim(); const accountName=$("#paymentAccountName").value.trim(); const isPreferred=$("#paymentIsPreferred").checked; const qrInput=$("#paymentQrFile"); const qrFile=qrInput&&qrInput.files&&qrInput.files.length?qrInput.files[0]:null; if(!paymentOption){toast("Please select a payment option.");return;} if(paymentOption!=="Cash"&&(!accountNumber||!accountName)){toast("Please enter the account number and account name.");return;} try{setLoading(true,"Saving payment details..."); let qrFileUrl=""; if(paymentOption!=="Cash"&&qrFile){setLoading(true,"Preparing QR code..."); const qr=await preparePaymentProof(qrFile); setLoading(true,"Uploading QR code..."); const uploadResult = await uploadPaymentProofToSupabase(
        qr,
        state.user.userId,
        crypto.randomUUID()
      ); qrFileUrl = uploadResult || ""; if(!qrFileUrl)throw new Error("QR code uploaded, but no file path was returned.");} const { error: saveError } = await supabaseClient
        .from("payment_details")
        .insert({
          user_id: state.user.userId,
          payment_option: paymentOption,
          account_number: accountNumber,
          account_name: accountName,
          qr_file_url: qrFileUrl || null,
          is_preferred: isPreferred,
          status: "ACTIVE"
        });

      if (saveError) {
        throw saveError;
      } closeModal(); await renderSavedPaymentDetails(); toast("Payment details saved.");}catch(error){console.error("SAVE PAYMENT DETAILS ERROR:",error);toast(error&&error.message?error.message:"Something went wrong. Please try again.");}finally{setLoading(false);}}

async function updateProfile(event) {

  event.preventDefault();

  const displayName =
    $("#profileDisplayName").value.trim();

  try {

    setLoading(true, "Saving...");

    const { data: updatedProfile, error } =
      await supabaseClient
        .from("profiles")
        .update({
          display_name: displayName
        })
        .eq("id", state.user.userId)
        .select("*")
        .single();

    if (error) {
      throw error;
    }

    state.user = {
      ...state.user,
      displayName: updatedProfile.display_name,
      username: updatedProfile.username,
      status: updatedProfile.status,
      createdAt: updatedProfile.created_at
    };

    toast("Profile updated.");

    renderProfile();

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }
}


async function changePassword(event) {

  event.preventDefault();

  const currentPassword =
    $("#currentPassword").value;

  const newPassword =
    $("#newPassword").value;

  const confirmPassword =
    $("#confirmNewPassword").value;

  if (newPassword !== confirmPassword) {
    toast("Passwords do not match.");
    return;
  }

  try {

    setLoading(true, "Changing password...");

    const {
      data: { user: currentUser },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !currentUser) {
      throw userError || new Error("Your session has expired.");
    }

    /*
     * Supabase Auth does not expose the current password for comparison.
     * Re-authenticate by signing in with the current password first.
     */
    if (!currentUser.email) {
      throw new Error("Your account does not have an email address.");
    }

    const { error: reauthError } =
      await supabaseClient.auth.signInWithPassword({
        email: currentUser.email,
        password: currentPassword
      });

    if (reauthError) {
      throw new Error("Your current password is incorrect.");
    }

    const { error: updatePasswordError } =
      await supabaseClient.auth.updateUser({
        password: newPassword
      });

    if (updatePasswordError) {
      throw updatePasswordError;
    }

    $("#passwordForm").reset();

    toast("Password changed.");

  } catch (error) {

    toast(error.message);

  } finally {

    setLoading(false);

  }
}


/* =========================================================
   UI HELPERS
   ========================================================= */

function showAuth() {

  $("#authView").classList.remove("hidden");
  $("#mainApp").classList.add("hidden");

}


function showApp() {

  $("#authView").classList.add("hidden");
  $("#mainApp").classList.remove("hidden");

}


async function runWebPushDiagnostics() {
  const results = [];

  const addResult = (label, status, detail = "") => {
    results.push({
      label,
      status,
      detail
    });
  };

  try {
    addResult(
      "Web Push API",
      ("serviceWorker" in navigator && "PushManager" in window)
        ? "PASS"
        : "FAIL"
    );

    addResult(
      "Notification API",
      ("Notification" in window)
        ? "PASS"
        : "FAIL"
    );

    if (!("serviceWorker" in navigator)) {
      addResult(
        "Service Worker",
        "FAIL",
        "Service workers are not supported."
      );
    } else {
      const registration =
        await navigator.serviceWorker.getRegistration();

      addResult(
        "Service Worker registration",
        registration ? "PASS" : "FAIL",
        registration
          ? "A service worker is registered."
          : "No service worker registration found."
      );

      if (registration) {
        addResult(
          "Service Worker state",
          registration.active ? "PASS" : "FAIL",
          registration.active
            ? "Service worker is active."
            : "Service worker is not active yet."
        );

        try {
          const ready =
            await navigator.serviceWorker.ready;

          addResult(
            "Service Worker ready",
            ready ? "PASS" : "FAIL"
          );

          let permission =
            Notification.permission;

          addResult(
            "Notification permission",
            permission === "granted"
              ? "PASS"
              : permission.toUpperCase(),
            `Current permission: ${permission}`
          );

          if (permission === "default") {
            permission =
              await Notification.requestPermission();

            addResult(
              "Notification permission request",
              permission === "granted"
                ? "PASS"
                : "FAIL",
              `Result: ${permission}`
            );
          }

          if (permission === "granted") {
            let subscription =
              await ready.pushManager.getSubscription();

            if (!subscription) {
              try {
                subscription =
                  await ready.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey:
                      urlBase64ToUint8Array(
                        OWEME_VAPID_PUBLIC_KEY
                      )
                  });

                addResult(
                  "Create PushSubscription",
                  "PASS",
                  "A new browser push subscription was created."
                );
              } catch (error) {
                addResult(
                  "Create PushSubscription",
                  "FAIL",
                  error.message || String(error)
                );
              }
            } else {
              addResult(
                "Existing PushSubscription",
                "PASS",
                "An existing browser push subscription was found."
              );
            }

            if (subscription) {
              const subscriptionJson =
                subscription.toJSON();

              addResult(
                "Push endpoint",
                subscriptionJson.endpoint
                  ? "PASS"
                  : "FAIL",
                subscriptionJson.endpoint
                  ? subscriptionJson.endpoint.substring(0, 100) + "..."
                  : "No endpoint found."
              );

              if (state.user?.userId) {
                const { error } =
                  await supabaseClient
                    .from("push_tokens")
                    .upsert(
                      {
                        user_id:
                          state.user.userId,
                        token:
                          JSON.stringify(
                            subscriptionJson
                          ),
                        platform: "web",
                        updated_at:
                          new Date().toISOString()
                      },
                      {
                        onConflict:
                          "user_id,token"
                      }
                    );

                addResult(
                  "Supabase push_tokens",
                  error ? "FAIL" : "PASS",
                  error
                    ? `${error.message} (${error.code || "no code"})`
                    : "Web push subscription saved."
                );
              } else {
                addResult(
                  "Logged-in user",
                  "FAIL",
                  "state.user.userId is missing."
                );
              }
            }
          }
        } catch (error) {
          addResult(
            "Web Push initialization",
            "FAIL",
            error.message || String(error)
          );
        }
      }
    }
  } catch (error) {
    addResult(
      "Diagnostics",
      "FAIL",
      error.message || String(error)
    );
  }

  openModal(`
    <div class="modal-header">
      <h3>PWA Notification Test</h3>
      <button
        class="modal-close"
        onclick="closeModal()"
        aria-label="Close"
      >×</button>
    </div>

    <div class="modal-body">
      ${results.map(result => `
        <div style="
          padding:10px 0;
          border-bottom:1px solid rgba(0,0,0,.08);
        ">
          <strong>${escapeHtml(result.label)}</strong>
          <div style="
            margin-top:4px;
            font-weight:700;
          ">
            ${escapeHtml(result.status)}
          </div>
          ${
            result.detail
              ? `<div style="
                  margin-top:4px;
                  font-size:13px;
                  opacity:.75;
                ">${escapeHtml(result.detail)}</div>`
              : ""
          }
        </div>
      `).join("")}
    </div>
  `);
}




async function handleSharedGroupLink(groupId) {

  if (!groupId) {
    return;
  }

  try {

    const {
      data: { user },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      return;
    }

    const {
      data: group,
      error: groupError
    } = await supabaseClient
      .rpc("get_shared_group", {
        p_group_id: groupId
      })
      .single();

    if (groupError || !group) {

      console.error(
        "SHARED GROUP LOAD ERROR:",
        groupError
      );

      toast(
        "This group could not be found or is no longer active."
      );

      return;
    }

    const {
      data: existingMembership,
      error: membershipError
    } = await supabaseClient
      .from("group_members")
      .select("group_id, status")
      .eq("group_id", group.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (membershipError) {

      console.error(
        "CHECK GROUP MEMBERSHIP ERROR:",
        membershipError
      );

    }

    if (
      existingMembership &&
      String(existingMembership.status).toUpperCase() ===
      "ACTIVE"
    ) {

      openModal(`
        <div class="modal-header">
          <h3>Already a member</h3>

          <button
            class="modal-close"
            onclick="closeModal()"
            aria-label="Close"
          >×</button>
        </div>

        <div class="modal-body">

          <p>
            You are already a member of
            <strong>${escapeHtml(group.group_name)}</strong>.
          </p>

          <button
            class="primary-button"
            onclick="
              closeModal();
              openGroup('${group.id}');
            "
          >
            Open Group
          </button>

        </div>
      `);

      return;
    }

    openModal(`
      <div class="modal-header">
        <h3>Join Group</h3>

        <button
          class="modal-close"
          onclick="closeModal()"
          aria-label="Close"
        >×</button>
      </div>

      <div class="modal-body">

        <p>
          You've been invited to join
          <strong>${escapeHtml(group.group_name)}</strong>.
        </p>

        <p class="muted">
          Join this group to view expenses,
          balances, and settlements.
        </p>

        <button
          class="primary-button"
          onclick="joinSharedGroup('${group.id}')"
        >
          Join Group
        </button>

      </div>
    `);

  } catch (error) {

    console.error(
      "SHARED GROUP LINK ERROR:",
      error
    );

    toast(
      error?.message ||
      "Unable to open the group link."
    );

  }

}


async function joinSharedGroup(groupId) {

  try {

    const {
      data: { user },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error("Please log in first.");
    }

    setLoading(true, "Joining group...");

    const {
      data: joinedGroup,
      error: joinError
    } = await supabaseClient
      .rpc("join_shared_group", {
        p_group_id: groupId
      })
      .single();

    if (joinError) {
      throw joinError;
    }

    if (!joinedGroup) {
      throw new Error(
        "The group could not be joined."
      );
    }

    closeModal();

    toast(
      `You joined ${joinedGroup.group_name}!`
    );

    state.groupsLoadedAt = 0;

    await loadGroups();

    await openGroup(joinedGroup.id);

  } catch (error) {

    console.error(
      "JOIN SHARED GROUP ERROR:",
      error
    );

    toast(
      error?.message ||
      "Unable to join the group."
    );

  } finally {

    setLoading(false);

  }

}


function openModal(html) {

  const modal = $("#modal");

  // Keep the modal outside #mainApp so it cannot be trapped
  // behind the fixed app header or another stacking context.
  if (modal.parentElement !== document.body) {
    document.body.appendChild(modal);
  }

  $("#modalContent").innerHTML = html;

  modal.classList.remove("hidden");

}


function closeModal() {

  $("#modal").classList.add("hidden");

  $("#modalContent").innerHTML = "";

}


function setLoading(show, text = "Loading...") {

  $("#loadingText").textContent = text;

  $("#loading").classList.toggle(
    "hidden",
    !show
  );

}


let toastTimer;

function toast(message) {

  const element = $("#toast");

  element.textContent = message;

  element.classList.add("show");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    element.classList.remove("show");
  }, 2800);

}


function formatMoney(value) {

  return new Intl.NumberFormat(
    "en-PH",
    {
      style: "currency",
      currency: "PHP",
      maximumFractionDigits: 2
    }
  ).format(Number(value || 0));

}


function formatBalance(value) {

  const number = Number(value || 0);

  if (Math.abs(number) < 0.005) {
    return "₱0.00";
  }

  return number > 0
    ? `+${formatMoney(number)}`
    : `-${formatMoney(Math.abs(number))}`;

}


function balanceClass(value) {

  const number = Number(value || 0);

  if (number > 0.005) return "balance-positive";
  if (number < -0.005) return "balance-negative";

  return "";
}


function formatDate(value) {

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString(
    "en-PH",
    {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }
  );

}


function formatTransactionDate(value) {

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return date.toLocaleDateString(
    "en-US",
    {
      month: "short",
      day: "numeric",
      year: "numeric"
    }
  );

}


function escapeHtml(value) {

  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

}

/* =========================================================
   GLOBAL ACTION HANDLERS
   Make dynamically-rendered onclick buttons callable.
   ========================================================= */

window.openAddExpenseModal = openAddExpenseModal;
window.openPayables = openPayables;
window.openReceivables = openReceivables;
window.openMembersModal = openMembersModal;
window.openSettlePayment = openSettlePayment;
window.openReceivableDetails = openReceivableDetails;
window.openExpenseDetails = openExpenseDetails;
window.deleteExpense = deleteExpense;
window.reviewPayment = reviewPayment;
window.openRejectPayment = openRejectPayment;
window.processRejectPayment = processRejectPayment;
window.confirmPaymentSubmission = confirmPaymentSubmission;
window.confirmSubmittedPayment = confirmSubmittedPayment;
window.processConfirmPayment = processConfirmPayment;
function viewPaymentProof(proofFileUrl) {

  const url =
    String(proofFileUrl || "").trim();

  if (!url) {
    toast("Payment proof is not available.");
    return;
  }

  try {

    const decodedUrl =
      decodeURIComponent(url);

    window.open(
      decodedUrl,
      "_blank",
      "noopener,noreferrer"
    );

  } catch (error) {

    console.error(
      "VIEW PAYMENT PROOF ERROR:",
      error
    );

    window.open(
      url,
      "_blank",
      "noopener,noreferrer"
    );
  }
}


window.viewPaymentProof = viewPaymentProof;
window.markSettlementPaid = markSettlementPaid;

/* ===== NOTIFICATION BADGE ===== */

/* ===== LOAD NOTIFICATION COUNT ===== */

async function loadNotificationCount() {

  if (!state.user?.userId) {
    return;
  }

  try {

    const {
      count,
      error
    } = await supabaseClient
      .from("notifications")
      .select("id", {
        count: "exact",
        head: true
      })
      .eq("user_id", state.user.userId)
      .eq("is_read", false);

    if (error) {
      throw error;
    }

    const badge =
      document.getElementById("notificationBadge");

    if (!badge) {
      return;
    }

    const unreadCount =
      Number(count || 0);

    if (unreadCount > 0) {

      badge.textContent =
        unreadCount > 99
          ? "99+"
          : String(unreadCount);

      badge.classList.remove("hidden");

    } else {

      badge.textContent = "0";
      badge.classList.add("hidden");

    }

  } catch (error) {

    console.error(
      "LOAD NOTIFICATION COUNT ERROR:",
      error
    );

  }

}


/* =========================================================
   NOTIFICATIONS
   ========================================================= */

async function loadNotifications() {

  if (!state.user?.userId) {
    return [];
  }

  const {
    data,
    error
  } = await supabaseClient
    .from("notifications")
    .select(`
      id,
      user_id,
      actor_user_id,
      type,
      title,
      message,
      group_id,
      expense_id,
      settlement_id,
      payment_submission_id,
      invitation_id,
      is_read,
      created_at
    `)
    .eq("user_id", state.user.userId)
    .order("created_at", {
      ascending: false
    })
    .limit(50);

  if (error) {
    throw error;
  }

  return data || [];
}


function formatNotificationTime(value) {

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const diff =
    Math.floor(
      (Date.now() - date.getTime()) / 1000
    );

  if (diff < 60) {
    return "Just now";
  }

  if (diff < 3600) {
    const minutes = Math.floor(diff / 60);
    return `${minutes}m ago`;
  }

  if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    return `${hours}h ago`;
  }

  if (diff < 604800) {
    const days = Math.floor(diff / 86400);
    return `${days}d ago`;
  }

  return date.toLocaleDateString();
}


async function openNotifications() {

  try {

    setLoading(true, "Loading notifications...");

    const notifications =
      await loadNotifications();

    openModal(`

      <div class="notifications-panel">

        <div class="notifications-header">

          <div>
            <h2>Notifications</h2>
            <p class="muted">
              Updates about your groups, expenses, and payments.
            </p>
          </div>

          ${
            notifications.some(
              notification => !notification.is_read
            )
              ? `
                <button
                  type="button"
                  class="secondary-button"
                  onclick="markAllNotificationsRead()"
                >
                  Mark all as read
                </button>
              `
              : ""
          }

        </div>

        <div class="notifications-list">

          ${
            notifications.length
              ? notifications.map(notification => `

                <button
                  type="button"
                  class="
                    notification-item
                    ${notification.is_read ? "" : "unread"}
                  "
                  onclick="openNotification('${escapeHtml(notification.id)}')"
                >

                  <div class="notification-item-content">

                    <div class="notification-item-title">
                      ${escapeHtml(notification.title)}
                    </div>

                    <div class="notification-item-message">
                      ${escapeHtml(notification.message)}
                    </div>

                    <div class="notification-item-time">
                      ${formatNotificationTime(notification.created_at)}
                    </div>

                  </div>

                  ${
                    !notification.is_read
                      ? `<span class="notification-unread-dot"></span>`
                      : ""
                  }

                </button>

              `).join("")
              : `
                <div class="card empty">
                  You're all caught up.
                </div>
              `
          }

        </div>

      </div>

    `);

  } catch (error) {

    console.error(
      "LOAD NOTIFICATIONS ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to load notifications."
    );

  } finally {

    setLoading(false);

  }
}


async function openNotification(notificationId) {

  try {

    const {
      data: notification,
      error
    } = await supabaseClient
      .from("notifications")
      .select("*")
      .eq("id", notificationId)
      .eq("user_id", state.user.userId)
      .single();

    if (error) {
      throw error;
    }

    if (!notification) {
      return;
    }

    if (!notification.is_read) {

      const {
        error: updateError
      } = await supabaseClient
        .from("notifications")
        .update({
          is_read: true
        })
        .eq("id", notificationId)
        .eq("user_id", state.user.userId);

      if (updateError) {
        throw updateError;
      }

    }

    await loadNotificationCount();

    closeModal();

    const notificationType =
      String(notification.type || "").toUpperCase();

    /*
     * Invitations
     */
    if (
      notificationType.startsWith("INVITATION_")
    ) {
      await navigate("invites");
      return;
    }

    /*
     * Group, member, expense, payment,
     * and settlement notifications all
     * belong to a specific group.
     */
    if (notification.group_id) {

      await openGroup(
        notification.group_id
      );

      return;

    }

  } catch (error) {

    console.error(
      "OPEN NOTIFICATION ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to open notification."
    );

  }

}

async function markAllNotificationsRead() {

  try {

    const {
      error
    } = await supabaseClient
      .from("notifications")
      .update({
        is_read: true
      })
      .eq("user_id", state.user.userId)
      .eq("is_read", false);

    if (error) {
      throw error;
    }

    await loadNotificationCount();

    closeModal();

    toast("All notifications marked as read.");

  } catch (error) {

    console.error(
      "MARK ALL NOTIFICATIONS READ ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to update notifications."
    );

  }
}



/* Nudge feature */

async function openNudgeConfirmation(settlementId) {
  setLoading(true, "Checking outstanding balance...");

  try {
    const settlements = await loadCurrentSettlements();

    const settlement = settlements.find(item =>
      String(item.settlementId) === String(settlementId) &&
      String(item.toUserId) === String(state.user.userId)
    );

    if (!settlement) {
      toast("Receivable not found.");
      return;
    }

    const { data: payments, error } = await supabaseClient
      .from("payment_submissions")
      .select("amount_paid, status")
      .eq("settlement_id", settlementId)
      .in("status", ["CONFIRMED", "SUBMITTED"]);

    if (error) throw error;

    const confirmed = (payments || [])
      .filter(p => p.status === "CONFIRMED")
      .reduce((sum, p) => sum + Number(p.amount_paid || 0), 0);

    const pending = (payments || [])
      .filter(p => p.status === "SUBMITTED")
      .reduce((sum, p) => sum + Number(p.amount_paid || 0), 0);

    const remaining = Math.max(
      0,
      Number(settlement.amount || 0) - confirmed
    );

    const availableToNudge = Math.max(0, remaining - pending);

    if (remaining < 0.01) {
      toast("This receivable is already settled.");
      return;
    }

    if (availableToNudge < 0.01) {
      toast("The remaining amount is awaiting payment approval.");
      return;
    }

    const username = escapeHtml(settlement.fromUsername);

    openModal(`
      <h2>Nudge ${escapeHtml(settlement.fromDisplayName || settlement.fromUsername || "Unknown")}</h2>

      <p class="muted">
        Send a friendly payment reminder?
      </p>

      <div class="card">
        <div class="user-name">${escapeHtml(settlement.fromDisplayName || settlement.fromUsername || "Unknown")}</div>
        <div style="margin-top: 8px;">
          Outstanding: <strong>${formatMoney(remaining)}</strong>
        </div>
        ${
          pending > 0
            ? `
              <div class="muted" style="margin-top: 6px;">
                Awaiting approval: ${formatMoney(pending)}
              </div>
            `
            : ""
        }
        <div style="margin-top: 8px;">
          Reminder amount:
          <strong>${formatMoney(availableToNudge)}</strong>
        </div>
      </div>

      <p class="muted" style="margin-top: 14px;">
        Your group member will receive a notification
        reminding them about this payment.
      </p>

      <div class="close-group-confirmation-actions"
           style="margin-top: 20px;">

        <button
          type="button"
          class="secondary-button"
          onclick="openReceivables()"
        >
          Cancel
        </button>

        <button
          type="button"
          class="small-button nudge-button"
          id="confirmNudgeButton"
          onclick="sendNudge('${settlement.settlementId}')"
        >
          Send Nudge
        </button>

      </div>
    `);

  } catch (error) {
    toast(error.message || "Unable to prepare nudge.");
  } finally {
    setLoading(false);
  }
}


async function sendNudge(settlementId) {
  const button = document.getElementById("confirmNudgeButton");

  if (button?.disabled) return;

  if (button) {
    button.disabled = true;
    button.textContent = "Sending...";
  }

  try {
    const settlements = await loadCurrentSettlements();

    const settlement = settlements.find(item =>
      String(item.settlementId) === String(settlementId) &&
      String(item.toUserId) === String(state.user.userId)
    );

    if (!settlement) {
      throw new Error("Receivable not found.");
    }

    // Recheck the balance in case a payment was made
    // after the confirmation modal was opened.
    const { data: payments, error: paymentError } =
      await supabaseClient
        .from("payment_submissions")
        .select("amount_paid, status")
        .eq("settlement_id", settlementId)
        .in("status", ["CONFIRMED", "SUBMITTED"]);

    if (paymentError) throw paymentError;

    const unavailable = (payments || [])
      .reduce(
        (sum, payment) => sum + Number(payment.amount_paid || 0),
        0
      );

    const amountToNudge =
      Number(settlement.amount || 0) - unavailable;

    if (amountToNudge < 0.01) {
      throw new Error(
        "No outstanding amount is currently available to nudge."
      );
    }

    const { error } = await supabaseClient
      .from("nudges")
      .insert({
        settlement_id: settlement.settlementId,
        sender_user_id: state.user.userId,
        recipient_user_id: settlement.fromUserId
      });

    if (error) throw error;

    await loadNotificationCount();
    await openReceivables();

    toast("Nudge sent successfully!");

  } catch (error) {
    toast(error.message || "Unable to send nudge.");

    if (button) {
      button.disabled = false;
      button.textContent = "Send Nudge";
    }
  }
}

function formatNudgeTime(createdAt) {
  const timestamp = new Date(createdAt);

  if (Number.isNaN(timestamp.getTime())) {
    return "recently";
  }

  const diffMs = Date.now() - timestamp.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes < 1) {
    return "just now";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);

  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  }

  const diffDays = Math.floor(diffHours / 24);

  if (diffDays < 30) {
    return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  }

  return timestamp.toLocaleDateString();
}

async function createPayMeLink(paymentDetailId) {
  setLoading(true, "Creating PayMe link...");

  try {
    const details = await loadPaymentDetails();

    const detail = details.find(
      item =>
        String(item.paymentDetailId) ===
        String(paymentDetailId)
    );

    if (!detail) {
      throw new Error("Payment details not found.");
    }

    const tokenBytes = new Uint8Array(24);
    crypto.getRandomValues(tokenBytes);

    const token = Array.from(tokenBytes)
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    let qrPublicPath = "";
    let qrImageDataUrl = "";

    if (detail.qrFileUrl) {
      const { data: qrFile, error: downloadError } =
        await supabaseClient.storage
          .from("payment-proofs")
          .download(detail.qrFileUrl);

      if (downloadError) {
        throw downloadError;
      }

      qrImageDataUrl =
        await new Promise((resolve, reject) => {
          const reader = new FileReader();

          reader.onload = () => {
            resolve(reader.result);
          };

          reader.onerror = () => {
            reject(
              new Error(
                "Unable to load payment QR code."
              )
            );
          };

          reader.readAsDataURL(qrFile);
        });

      const originalPath = String(detail.qrFileUrl);
      const extensionMatch = originalPath.match(/\.([a-zA-Z0-9]+)$/);
      const extension = extensionMatch
        ? extensionMatch[1].toLowerCase()
        : "png";

      qrPublicPath =
        `${state.user.userId}/${token}.${extension}`;

      const { error: uploadError } =
        await supabaseClient.storage
          .from("payme-qrs")
          .upload(qrPublicPath, qrFile, {
            contentType: qrFile.type || "image/png",
            upsert: false
          });

      if (uploadError) {
        throw uploadError;
      }
    }

    const { data, error } = await supabaseClient
      .from("payme_links")
      .insert({
        token,
        owner_user_id: state.user.userId,
        payment_detail_id: detail.paymentDetailId,
        qr_public_path: qrPublicPath || null,
        is_active: true
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    const paymeUrl =
      new URL(
        `pay.html?token=${encodeURIComponent(data.token)}`,
        window.location.href
      ).href;

    openModal(`
      <h2>PayMe Link Ready</h2>

      <p class="muted">
        Anyone with this link can view the payment details
        you selected.
      </p>

      <div class="card payme-link-card">
        <div class="muted">Payment Method</div>
        <strong>${escapeHtml(detail.paymentOption)}</strong>

        ${
          detail.accountNumber
            ? `
              <div
                class="muted"
                style="margin-top:12px;"
              >
                Account Number
              </div>

              <div
                style="
                  display:flex;
                  align-items:center;
                  justify-content:space-between;
                  gap:10px;
                  margin-top:4px;
                "
              >
                <strong
                  style="
                    min-width:0;
                    overflow:hidden;
                    text-overflow:ellipsis;
                    white-space:nowrap;
                  "
                >
                  ${escapeHtml(detail.accountNumber)}
                </strong>

                <button
                  type="button"
                  aria-label="Copy account number"
                  title="Copy account number"
                  onclick="copyPaymentAccountNumber('${escapeHtml(detail.accountNumber)}')"
                  style="
                    flex:0 0 auto;
                    width:34px;
                    height:34px;
                    border:0;
                    border-radius:50%;
                    background:#eaf2e6;
                    color:#185c36;
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    cursor:pointer;
                    padding:0;
                  "
                >
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <rect
                      x="9"
                      y="9"
                      width="13"
                      height="13"
                      rx="2"
                      ry="2"
                    ></rect>
                    <path
                      d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                    ></path>
                  </svg>
                </button>
              </div>
            `
            : ""
        }

        <div
          class="muted"
          style="margin-top:12px;"
        >
          QR Code
        </div>

        ${
          qrImageDataUrl
            ? `
              <div
                style="
                  margin-top:10px;
                  display:flex;
                  justify-content:center;
                  align-items:center;
                "
              >
                <img
                  src="${escapeHtml(qrImageDataUrl)}"
                  alt="Payment QR Code"
                  style="
                    width:220px;
                    height:220px;
                    max-width:100%;
                    object-fit:contain;
                    border-radius:12px;
                    background:#fff;
                    padding:10px;
                    box-sizing:border-box;
                  "
                />
              </div>
            `
            : `
              <div
                class="muted"
                style="margin-top:10px;"
              >
                No payment QR code available.
              </div>
            `
        }
      </div>

      <div class="payme-link-actions">
        <button
          type="button"
          class="secondary-button"
          onclick="copyPayMeLink('${escapeHtml(paymeUrl)}')"
        >
          Copy Link
        </button>

        <button
          type="button"
          class="primary-button"
          onclick="sharePayMeLink('${escapeHtml(paymeUrl)}')"
        >
          Share
        </button>

      </div>
    `);

  } catch (error) {
    console.error("CREATE PAYME LINK ERROR:", error);
    toast(error.message || "Unable to create PayMe link.");
  } finally {
    setLoading(false);
  }
}

async function createSettlementPayMeLink(settlementId) {
  setLoading(true, "Creating PayMe link...");

  try {
    const settlements = await loadCurrentSettlements();

    const settlement = settlements.find(
      item =>
        String(item.settlementId) ===
        String(settlementId)
    );

    if (!settlement) {
      throw new Error("Settlement not found.");
    }

    if (
      String(settlement.toUserId) !==
      String(state.user.userId)
    ) {
      throw new Error("You can only create a PayMe link for money owed to you.");
    }

    const { data: paymentRows, error: paymentError } =
      await supabaseClient
        .from("payment_submissions")
        .select("*")
        .eq("settlement_id", settlement.settlementId)
        .eq("payer_user_id", settlement.fromUserId)
        .in("status", ["CONFIRMED", "SUBMITTED"]);

    if (paymentError) {
      throw paymentError;
    }

    const confirmedPaid = (paymentRows || [])
      .filter(
        payment =>
          String(payment.status).toUpperCase() ===
          "CONFIRMED"
      )
      .reduce(
        (total, payment) =>
          total + Number(payment.amount_paid || 0),
        0
      );

    const pendingPaid = (paymentRows || [])
      .filter(
        payment =>
          String(payment.status).toUpperCase() ===
          "SUBMITTED"
      )
      .reduce(
        (total, payment) =>
          total + Number(payment.amount_paid || 0),
        0
      );

    const remainingAmount = Math.max(
      0,
      Number(settlement.amount || 0) -
        confirmedPaid -
        pendingPaid
    );

    if (remainingAmount <= 0.009) {
      throw new Error(
        "This settlement has already been fully paid."
      );
    }

    const details = await loadPaymentDetails();

    if (!details.length) {
      throw new Error(
        "Please add payment details to your profile first."
      );
    }

    const detail = details[0];

    const tokenBytes = new Uint8Array(24);
    crypto.getRandomValues(tokenBytes);

    const token = Array.from(tokenBytes)
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    let qrPublicPath = "";

    if (detail.qrFileUrl) {
      const {
        data: qrFile,
        error: downloadError
      } = await supabaseClient.storage
        .from("payment-proofs")
        .download(detail.qrFileUrl);

      if (downloadError) {
        throw downloadError;
      }

      qrImageDataUrl =
        await new Promise((resolve, reject) => {
          const reader = new FileReader();

          reader.onload = () =>
            resolve(reader.result);

          reader.onerror = () =>
            reject(
              new Error("Unable to load payment QR code.")
            );

          reader.readAsDataURL(qrFile);
        });

      const originalPath =
        String(detail.qrFileUrl);

      const extensionMatch =
        originalPath.match(
          /\.([a-zA-Z0-9]+)$/
        );

      const extension =
        extensionMatch
          ? extensionMatch[1].toLowerCase()
          : "png";

      qrPublicPath =
        `${state.user.userId}/${token}.${extension}`;

      const {
        error: uploadError
      } = await supabaseClient.storage
        .from("payme-qrs")
        .upload(
          qrPublicPath,
          qrFile,
          {
            contentType:
              qrFile.type || "image/png",
            upsert: false
          }
        );

      if (uploadError) {
        throw uploadError;
      }
    }

    const {
      data,
      error
    } = await supabaseClient
      .from("payme_links")
      .insert({
        token,
        owner_user_id: state.user.userId,
        payment_detail_id:
          detail.paymentDetailId,
        settlement_id:
          settlement.settlementId,
        amount: remainingAmount,
        qr_public_path:
          qrPublicPath || null,
        is_active: true
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    const paymeUrl =
      new URL(
        `pay.html?token=${encodeURIComponent(data.token)}`,
        window.location.href
      ).href;

    openModal(`
      <h2>PayMe Link Ready</h2>

      <p class="muted">
        This link is for
        <strong>
          ${escapeHtml(settlement.fromDisplayName || settlement.fromUsername || "the payer")}
        </strong>
        and the remaining amount below.
      </p>

      <div class="card payme-link-card">

        <div class="muted">
          Amount to Pay
        </div>

        <strong>
          ${formatMoney(remainingAmount)}
        </strong>

        <div
          class="muted"
          style="margin-top:12px;"
        >
          Payment Method
        </div>

        <strong>
          ${escapeHtml(detail.paymentOption)}
        </strong>

        ${
          detail.accountNumber
            ? `
              <div
                class="muted"
                style="margin-top:12px;"
              >
                Account Number
              </div>

              <div
                style="
                  display:flex;
                  align-items:center;
                  justify-content:space-between;
                  gap:10px;
                  margin-top:4px;
                "
              >
                <strong
                  style="
                    min-width:0;
                    overflow:hidden;
                    text-overflow:ellipsis;
                    white-space:nowrap;
                  "
                >
                  ${escapeHtml(detail.accountNumber)}
                </strong>

                <button
                  type="button"
                  aria-label="Copy account number"
                  title="Copy account number"
                  onclick="copyPaymentAccountNumber('${escapeHtml(detail.accountNumber)}')"
                  style="
                    flex:0 0 auto;
                    width:34px;
                    height:34px;
                    border:0;
                    border-radius:50%;
                    background:#eaf2e6;
                    color:#185c36;
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    cursor:pointer;
                    padding:0;
                  "
                >
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <rect
                      x="9"
                      y="9"
                      width="13"
                      height="13"
                      rx="2"
                      ry="2"
                    ></rect>
                    <path
                      d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                    ></path>
                  </svg>
                </button>
              </div>
            `
            : ""
        }

        <div
          class="muted"
          style="margin-top:12px;"
        >
          QR Code
        </div>

        ${
          qrImageDataUrl
            ? `
              <div
                style="
                  margin-top:10px;
                  display:flex;
                  justify-content:center;
                  align-items:center;
                "
              >
                <img
                  src="${escapeHtml(qrImageDataUrl)}"
                  alt="Payment QR Code"
                  style="
                    width:220px;
                    height:220px;
                    max-width:100%;
                    object-fit:contain;
                    border-radius:12px;
                    background:#fff;
                    padding:10px;
                    box-sizing:border-box;
                  "
                />
              </div>
            `
            : `
              <div
                class="muted"
                style="margin-top:10px;"
              >
                No payment QR code available.
              </div>
            `
        }

      </div>

      <div class="payme-link-actions">

        <button
          type="button"
          class="secondary-button"
          onclick="copyPayMeLink('${escapeHtml(paymeUrl)}')"
        >
          Copy Link
        </button>

        <button
          type="button"
          class="primary-button"
          onclick="sharePayMeLink('${escapeHtml(paymeUrl)}')"
        >
          Share
        </button>

      </div>
    `);

  } catch (error) {
    console.error(
      "CREATE SETTLEMENT PAYME LINK ERROR:",
      error
    );

    toast(
      error.message ||
      "Unable to create PayMe link."
    );

  } finally {
    setLoading(false);
  }
}


async function copyPaymentAccountNumber(accountNumber) {
  try {
    await navigator.clipboard.writeText(accountNumber);
    toast("Account number copied!");
  } catch (error) {
    toast("Unable to copy the account number.");
  }
}


async function copyPayMeLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast("PayMe link copied!");
  } catch (error) {
    toast("Unable to copy the PayMe link.");
  }
}


async function sharePayMeLink(url) {
  try {
    if (!navigator.share) {
      await copyPayMeLink(url);
      return;
    }

    await navigator.share({
      title: "PayMe",
      text: "Here's my OweMe PayMe link.",
      url
    });

  } catch (error) {
    if (error?.name !== "AbortError") {
      toast("Unable to share the PayMe link.");
    }
  }
}

function renderContactCard(contact) {

  const sharedGroups =
    Array.isArray(contact.sharedGroups)
      ? contact.sharedGroups
      : [];

  const lastSharedGroup =
    sharedGroups.length
      ? sharedGroups
          .slice()
          .sort((a, b) =>
            new Date(b.groupCreatedAt || 0) -
            new Date(a.groupCreatedAt || 0)
          )[0]
      : null;

  return `
    <div
      class="contact-list-item"
      data-contact-user-id="${escapeHtml(String(contact.userId))}"
      onclick="openContactDetails('${escapeHtml(String(contact.userId))}')"
    >

      <div class="contact-list-main">

        <div class="contact-list-primary">

          <span class="contact-list-display-name">
            ${escapeHtml(contact.displayName || "Unknown")}
          </span>

          <span class="contact-list-username">
            @${escapeHtml(contact.username || "")}
          </span>

        </div>

        <div class="contact-list-secondary">

          <span>
            ${sharedGroups.length}
            ${sharedGroups.length === 1 ? "shared group" : "shared groups"}
          </span>

          ${
            lastSharedGroup
              ? `
                <span class="contact-list-separator">·</span>
                <span>
                  Last shared:
                  ${escapeHtml(lastSharedGroup.groupName || "Group")}
                </span>
              `
              : ""
          }

        </div>

      </div>

    </div>
  `;
}

function switchGroupTab(tab) {

  const target = tab.dataset.groupTab;

  document.querySelectorAll(".history-tab").forEach(button => {
    button.classList.toggle(
      "active",
      button === tab
    );
  });

  document.querySelectorAll(".group-tab-panel").forEach(panel => {
    panel.hidden = (
      panel.id !==
      "groupTab" +
      target.charAt(0).toUpperCase() +
      target.slice(1)
    );
  });

  if (target === "pending") {
    loadPendingPayables();
    loadPendingPayments();
  }

}

/* =========================================================
   INVITES PAGE TABS
   Invitations | Contacts
========================================================= */

let invitesActiveTab = "invitations";

function renderInvitesTabs() {
  return `
    <div class="groups-tab-container invites-tab-container">
      <button
        type="button"
        class="groups-tab ${invitesActiveTab === "invitations" ? "active" : ""}"
        onclick="switchInvitesTab('invitations')"
      >
        Invitations
      </button>

      <button
        type="button"
        class="groups-tab ${invitesActiveTab === "contacts" ? "active" : ""}"
        onclick="switchInvitesTab('contacts')"
      >
        Contacts
      </button>
    </div>
  `;
}

async function switchInvitesTab(tab) {

  invitesActiveTab =
    tab === "contacts"
      ? "contacts"
      : "invitations";

  document
    .querySelectorAll(".invites-tab-container .groups-tab")
    .forEach(button => {
      const label = button.textContent.trim();

      button.classList.toggle(
        "active",
        (
          invitesActiveTab === "invitations" &&
          label === "Invitations"
        ) ||
        (
          invitesActiveTab === "contacts" &&
          label === "Contacts"
        )
      );
    });

  if (invitesActiveTab === "contacts") {
    await loadContacts();
  } else {
    await loadInvitations();
  }

}
