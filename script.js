const SUPABASE_URL = "https://khrawdzhvfdfrvbhbhge.supabase.co";

const SUPABASE_KEY = "sb_publishable_diLxiZhI5gM-L_WrCh2Hfg_er9qLNtB";

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

    showApp();

    await loadHome();

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
   API
   ========================================================= */


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
        amount,
        expense_participants (
          user_id,
          share_amount
        )
      `)
      .eq("group_id", groupId)
      .eq("status", "ACTIVE");

  if (expenseError) throw expenseError;

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

  return {
    success: true,
    data: {
      balances: Object.values(balances)
    }
  };
}


async function getSettlementsFromSupabase(groupId) {

  const balanceResult =
    await getBalancesFromSupabase(groupId);

  const balances =
    balanceResult.data.balances || [];

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

  const debtors = balances
    .filter(item => Number(item.balance) < -0.005)
    .map(item => ({
      userId: item.userId,
      amount: Math.abs(Number(item.balance))
    }));

  const creditors = balances
    .filter(item => Number(item.balance) > 0.005)
    .map(item => ({
      userId: item.userId,
      amount: Number(item.balance)
    }));

  const settlements = [];

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
      Math.round(
        Math.min(
          debtor.amount,
          creditor.amount
        ) * 100
      ) / 100;

    if (amount <= 0) {
      break;
    }

    const {
      data: settlementId,
      error: settlementError
    } = await supabaseClient.rpc(
      "ensure_settlement",
      {
        p_group_id: groupId,
        p_from_user_id: debtor.userId,
        p_to_user_id: creditor.userId,
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
        debtor.userId,

      fromUsername:
        memberMap[String(debtor.userId)]?.username || "",

      fromDisplayName:
        memberMap[String(debtor.userId)]?.displayName || "",

      toUserId:
        creditor.userId,

      toUsername:
        memberMap[String(creditor.userId)]?.username || "",

      toDisplayName:
        memberMap[String(creditor.userId)]?.displayName || "",

      amount,

      status:
        "UNPAID"

    });

    debtor.amount =
      Math.round(
        (debtor.amount - amount) * 100
      ) / 100;

    creditor.amount =
      Math.round(
        (creditor.amount - amount) * 100
      ) / 100;

    if (debtor.amount <= 0.005) {
      debtorIndex++;
    }

    if (creditor.amount <= 0.005) {
      creditorIndex++;
    }

  }

  return {
    success: true,

    settlements,

    data: {
      settlements
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

  document.querySelectorAll(".nav-item").forEach(function(button) {
    button.addEventListener("click", function() {
      navigate(button.dataset.page);
    });
  });

  if (refreshButton) {
    refreshButton.addEventListener("click", async function() {
      state.groupsLoadedAt = 0;
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

    await loadHome();

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
     * The database trigger on auth.users automatically
     * creates the OweMe profile using the username and
     * display name stored in Auth metadata.
     */

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
          displayName,

        status:
          "ACTIVE",

        createdAt:
          new Date().toISOString()
      };

      showApp();

      await loadHome();

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

    if (page === "history") {
      await loadHistory();
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

async function loadHome(initialGroups = null) {

  $("#pageTitle").textContent = "Home";

  try {

    if (initialGroups) {

      state.groups = initialGroups;
      state.groupsLoadedAt = Date.now();

    } else {

      await loadGroupsData();

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


    $("#content").innerHTML = `

      <div class="welcome">

        <h2>
          Hi,
          ${escapeHtml(
            state.user.displayName
          )}
          👋
        </h2>

        <p class="muted">
          Here's where things stand.
        </p>

      </div>


      <div class="card balance-card">

        <div class="balance-label">
          Your overall balance
        </div>

        <div
          class="balance-number
          ${balanceClass(totalBalanceRounded)}"
        >
          ${formatBalance(totalBalanceRounded)}
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

async function loadGroups() {

  $("#pageTitle").textContent = "Groups";

  await loadGroupsData();

  $("#content").innerHTML = `

    <button
      class="primary-button"
      onclick="openCreateGroupModal()"
      style="margin-bottom:16px"
    >
      + Create Group
    </button>

    ${
      state.groups.length
      ? state.groups.map(renderGroupCard).join("")
      : `
        <div class="card empty">
          No groups yet.
        </div>
      `
    }

  `;

  bindGroupCards();
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

    $("#content").innerHTML = `

      <div class="history-intro">

        <h2>Past adventures</h2>

        <p>
          Groups you've closed and kept for the memories.
        </p>

      </div>

      ${
        closedGroups.length
          ? closedGroups.map(group => `
              <div
                class="card group-card history-group-card"
                data-group-id="${escapeHtml(group.groupId)}"
              >

                <div>
                  <h3>
                    ${escapeHtml(group.groupName)}
                  </h3>

                  <p>
                    ${Number(group.memberCount || 0)}
                    member${group.memberCount === 1 ? "" : "s"}
                    · Closed
                  </p>
                </div>

                <div class="arrow">›</div>

              </div>
            `).join("")
          : `
              <div class="card empty-state">

                <h3>No adventures here yet</h3>

                <p>
                  Closed groups will appear here after everyone is settled.
                </p>

              </div>
            `
      }

    `;

    document
      .querySelectorAll(".history-group-card")
      .forEach(card => {

        card.addEventListener("click", () => {
          openGroup(card.dataset.groupId);
        });

      });

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


    (expenseRows || [])
      .forEach(expense => {

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


    group.myBalance =
      Number(
        (
          totalPaid -
          totalShare
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

      <div>
        <h3>${escapeHtml(group.groupName)}</h3>
        <p>${Number(group.memberCount || 0)} members</p>
      </div>

      <div class="arrow">›</div>

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

        const settlementId =
          `SET_${simpleHash(
            `${groupId}|${debtor.userId}|${creditor.userId}`
          )}`;


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

    const settlements =
      Object.values(
        settlementMap
      );


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

          toUserId:
            payment.recipient_user_id,

          toUsername:
            recipient?.username || "",

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

      });

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
      balances.find(
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
      : transaction.fromUsername
        ? `@${escapeHtml(transaction.fromUsername)}`
        : "—";

  const toLabel =
    toUserId === currentUserId
      ? "You"
      : transaction.toUsername
        ? `@${escapeHtml(transaction.toUsername)}`
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

    actionHtml = `
      <button
        type="button"
        class="table-action-button"
        onclick="openExpenseDetails('${escapeHtml(
          transaction.expenseId
        )}')"
      >
        View
      </button>
    `;

  } else if (isPayment) {

    const status =
      String(transaction.status || "").toUpperCase();

    actionHtml =
      status === "SUBMITTED" &&
      toUserId === currentUserId
        ? `
          <button
            type="button"
            class="table-action-button"
            onclick="reviewPayment('${escapeHtml(
              transaction.paymentSubmissionId
            )}')"
          >
            Review
          </button>
        `
        : `
          <button
            type="button"
            class="table-action-button"
            onclick="openPaymentTransaction('${escapeHtml(
              transaction.paymentSubmissionId
            )}')"
          >
            View
          </button>
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
        @${escapeHtml(expense.paidByUsername || "Unknown")}
      </div>

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
                    @${escapeHtml(participant.username || "Unknown")}
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
      <div class="close-group-confirmation-icon">✓</div>

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
          <div style="margin-top:16px;">

            <button
              class="add-expense-button"
              onclick="openAddExpenseModal()"
            >
              + Add Expense
            </button>

          </div>
        `
        : `
          <div class="group-closed-banner">
            ✓ This group is closed. You're viewing its history.
          </div>
        `
    }


    <div class="section-title">
      Your Balances
    </div>


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


    <div
      class="group-actions"
      style="margin-top:20px;"
    >

      <button
        class="action-button"
        onclick="openMembersModal()"
      >
        Members
      </button>

    </div>

    ${
      String(group.status).toUpperCase() === "ACTIVE"
        ? `
          <div class="group-close-section">

            <div class="group-close-note">
              Everyone settled? You can close this group and move it to History.
            </div>

            <button
              class="close-group-button"
              onclick="closeCurrentGroup()"
            >
              ✓ Close this group
            </button>

          </div>
        `
        : `
          <div class="group-closed-banner">
            ✓ This group is closed and saved in History.
          </div>
        `
    }

  `;


  loadGroupTransactions();

}


function renderExpense(expense) {

  const participantText =
    expense.participants.length === 1
      ? `For ${escapeHtml(expense.participants[0].username)}`
      : `${expense.participants.length} participants`;

  return `

    <div
      class="expense-card"
      data-expense-id="${escapeHtml(expense.expenseId)}"
    >

      <div class="expense-top">

        <div class="expense-payer">
          @${escapeHtml(expense.paidBy.username)}
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

function openCreateGroupModal() {

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

      <label>
        Add members
        <textarea
          id="newGroupMembers"
          placeholder="@ben90&#10;@carla21&#10;@dan88"
        ></textarea>
      </label>

      <small class="field-help">
        One username per line.
      </small>

      <button class="primary-button" type="submit">
        Create Group
      </button>

    </form>

  `);

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
      .map(x => x.trim().replace(/^@/, ""))
      .filter(Boolean);

  if (!groupName) {
    toast("Please enter a group name.");
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
      throw new Error("Your session has expired. Please log in again.");
    }

    /* ================================================
       2. CREATE GROUP
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
       3. ADD CREATOR AS ADMIN
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

      /*
       * The group was created but the creator could not
       * be added as a member. Stop here rather than
       * pretending the group was created successfully.
       */

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
       4. FIND INVITED USERS
       ================================================ */

    if (usernames.length) {

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
        .select("id, username, username_normalized")
        .in(
          "username_normalized",
          normalizedUsernames
        );

      if (profileError) {
        throw new Error(
          profileError.message ||
          "The group was created, but invited users could not be checked."
        );
      }


      /* ==============================================
         5. CREATE PENDING INVITATIONS
         ============================================== */

      const invitations = [];

      for (const profile of invitedProfiles || []) {

        /*
         * Do not invite yourself.
         */

        if (profile.id === user.id) {
          continue;
        }

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


      if (invitations.length) {

        const {
          error: invitationError
        } = await supabaseClient
          .from("invitations")
          .insert(invitations);

        if (invitationError) {
          throw new Error(
            invitationError.message ||
            "The group was created, but some invitations could not be sent."
          );
        }
      }
    }


    /* ================================================
       6. REFRESH GROUP STATE
       ================================================ */

    state.groupsLoadedAt = 0;

    closeModal();

    toast("Group created.");

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

function openAddExpenseModal() {

  const members = state.currentGroup.members;

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

      <div class="section-title">
        Paid by
      </div>

      <div class="card" style="margin-bottom:16px">

        <strong>
          @${escapeHtml(state.user.username)}
        </strong>

        <div class="muted" style="font-size:12px">
          You are paying for this expense.
        </div>

      </div>

      <div class="section-title">
        For
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

            <div>
              <div class="user-name">
                @${escapeHtml(member.username)}
              </div>

              <div class="user-handle">
                ${escapeHtml(member.displayName)}
              </div>
            </div>

          </label>

        `).join("")}

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

  $("#addExpenseForm").addEventListener(
    "submit",
    addExpense
  );
}


async function addExpense(event) {

  event.preventDefault();

  const amount =
    Number($("#expenseAmount").value);

  const description =
    $("#expenseDescription").value.trim();

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


    /* ================================================
       1. GET CURRENT USER
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


    const groupId =
      state.currentGroup.group.groupId;


    /* ================================================
       2. VERIFY PARTICIPANTS ARE ACTIVE MEMBERS
       ================================================ */

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


    /* ================================================
       3. CALCULATE EQUAL SHARES
       ================================================ */

    /*
     * Work in cents to avoid floating-point rounding
     * problems.
     */

    const amountCents =
      Math.round(
        amount * 100
      );

    const participantCount =
      uniqueParticipantIds.length;

    const baseShareCents =
      Math.floor(
        amountCents /
        participantCount
      );

    const remainderCents =
      amountCents %
      participantCount;

    const shares =
      uniqueParticipantIds.map(
        (userId, index) => {

          const shareCents =
            baseShareCents +
            (index < remainderCents ? 1 : 0);

          return {
            user_id: userId,
            share_amount:
              Number(
                (
                  shareCents / 100
                ).toFixed(2)
              )
          };

        }
      );


    /* ================================================
       4. CREATE EXPENSE
       ================================================ */

    const {
      data: expense,
      error: expenseError
    } = await supabaseClient
      .from("expenses")
      .insert({
        group_id: groupId,
        paid_by_user_id: user.id,
        amount: Number(amount.toFixed(2)),
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


    /* ================================================
       5. CREATE PARTICIPANT SHARES
       ================================================ */

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

      /*
       * Remove the expense if its participant rows
       * could not be created, so we don't leave behind
       * an incomplete expense.
       */

      await supabaseClient
        .from("expenses")
        .delete()
        .eq("id", expense.id);

      throw new Error(
        participantError.message ||
        "The expense could not be saved."
      );
    }


    /* ================================================
       6. REFRESH GROUP
       ================================================ */

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


/* =========================================================
   EXPENSE DETAILS
   ========================================================= */

function openExpenseDetails(expenseId) {

  const expense =
    state.currentGroup.expenses.find(
      x => x.expenseId === expenseId
    );

  if (!expense) return;

  const canManage =
    expense.createdBy === state.user.userId ||
    state.currentGroup.currentUserRole === "ADMIN";

  openModal(`

    <h2>Expense</h2>

    <div class="card">

      <div class="expense-top">

        <div>
          <div class="muted">Paid by</div>
          <strong>
            @${escapeHtml(expense.paidBy.username)}
          </strong>
        </div>

        <div class="expense-amount">
          ${formatMoney(expense.amount)}
        </div>

      </div>

      ${
        expense.description
        ? `
          <div style="margin-top:15px">
            ${escapeHtml(expense.description)}
          </div>
        `
        : ""
      }

    </div>

    <div class="section-title">
      Participants
    </div>

    <div class="card">

      ${expense.participants.map(participant => `

        <div class="member-row">

          <div>
            <div class="user-name">
              @${escapeHtml(participant.username)}
            </div>

            <div class="user-handle">
              ${escapeHtml(participant.displayName)}
            </div>
          </div>

          <strong>
            ${formatMoney(participant.shareAmount)}
          </strong>

        </div>

      `).join("")}

    </div>

    ${
      canManage
      ? `
        <button
          class="danger-button"
          onclick="deleteExpense('${escapeHtml(expense.expenseId)}')"
        >
          Delete Expense
        </button>
      `
      : ""
    }

  `);
}


async function deleteExpense(expenseId) {

  if (!confirm("Delete this expense?")) {
    return;
  }

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
                @${escapeHtml(item.username)}
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
                      @${escapeHtml(item.toUsername || "Unknown")}
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
                      onclick="openPayableDetails('${escapeHtml(item.settlementId)}')"
                    >
                      View details
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

    const paymentRows =
      relatedExpenses.length
        ? relatedExpenses.map(expense => {

            const participant =
              (expense.participants || []).find(item =>
                String(item.userId) ===
                String(state.user.userId)
              );

            return `
              <div
                class="balance-detail-row"
                style="align-items:flex-start;"
              >

                <div style="flex:1;">

                  <div class="user-name">
                    ${escapeHtml(
                      expense.description || "Expense"
                    )}
                  </div>

                  <div class="muted">
                    ${expense.date
                      ? new Date(expense.date)
                          .toLocaleDateString()
                      : ""}
                  </div>

                </div>

                <strong>
                  ${formatMoney(
                    Number(participant?.shareAmount || 0)
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

    openModal(`

      <h2>You owe @${escapeHtml(
        settlement.toUsername || "Unknown"
      )}</h2>

      <p class="muted">
        Outstanding amount
      </p>

      <div
        class="card"
        style="
          margin-top:16px;
          text-align:center;
          padding:24px;
        "
      >

        <div
          style="
            font-size:32px;
            font-weight:700;
          "
        >
          ${formatMoney(settlement.amount)}
        </div>

        <div class="muted">
          Remaining to pay
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
      await loadCurrentSettlements();

    const receivables =
      settlements.filter(item =>
        String(item.toUserId) ===
        String(state.user.userId)
      );

    openModal(`
      <h2>Receivables</h2>
      <p class="muted">What others still need to pay you.</p>

      ${receivables.length
        ? `
          <div class="balance-detail-list">
            ${receivables.map(item => `
              <div class="balance-detail-row">
                <div>
                  <div class="user-name">
                    @${escapeHtml(item.fromUsername)}
                  </div>
                  <div class="muted">
                    ${formatMoney(item.amount)}
                  </div>
                </div>
                <button
                  type="button"
                  class="small-button"
                  onclick="openReceivableDetails('${escapeHtml(item.settlementId)}')"
                >
                  Details
                </button>
              </div>
            `).join("")}
          </div>
        `
        : `<div class="card empty">Nobody owes you right now.</div>`
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
        .eq(
          "status",
          "CONFIRMED"
        )
        .order(
          "confirmed_at",
          {
            ascending: false
          }
        );

    if (paymentResult.error) {
      throw paymentResult.error;
    }

    const confirmedPayments =
      paymentResult.data || [];

    const paidAmount =
      confirmedPayments.reduce(
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
              <div
                class="balance-detail-row"
                style="align-items:flex-start;"
              >

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

    const paymentHistory =
      confirmedPayments.length
        ? confirmedPayments.map(payment => `

            <div
              class="balance-detail-row"
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

    openModal(`

      <h2>
        @${escapeHtml(
          settlement.fromUsername || "Unknown"
        )} owes you
      </h2>

      <div
        class="card"
        style="
          margin-top:16px;
          padding:24px;
        "
      >

        <div class="muted">
          Remaining
        </div>

        <div
          style="
            font-size:32px;
            font-weight:700;
            margin-top:4px;
          "
        >
          ${formatMoney(settlement.amount)}
        </div>

      </div>

      <div style="margin-top:24px;">

        <div class="section-title">
          Payment summary
        </div>

        <div class="card">

          <div class="balance-detail-row">
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

          <div class="balance-detail-row">
            <span class="muted">
              Paid so far
            </span>

            <strong>
              ${formatMoney(paidAmount)}
            </strong>
          </div>

          <div class="balance-detail-row">
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

        <div class="card">
          ${expenseRows}
        </div>

      </div>

      <div style="margin-top:24px;">

        <div class="section-title">
          Payment history
        </div>

        <div class="card">
          ${paymentHistory}
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
    <div
      class="settlement-row"
      style="margin-bottom:12px;"
    >

      <div>

        <strong>
          Payment received
        </strong>

        <div class="muted">
          ${escapeHtml(payment.paymentOption)}
        </div>

        <div
          style="
            margin-top:6px;
            font-size:18px;
            font-weight:700;
          "
        >
          ₱${Number(payment.amountPaid).toLocaleString(
            "en-PH",
            {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            }
          )}
        </div>

        ${
          payment.notes
            ? `
              <div
                class="muted"
                style="margin-top:4px;"
              >
                ${escapeHtml(payment.notes)}
              </div>
            `
            : ""
        }

      </div>

      <button
        type="button"
        class="small-button green-button"
        onclick="reviewPayment('${escapeHtml(payment.paymentSubmissionId)}')"
      >
        Review
      </button>

    </div>
  `;
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

        <div class="muted">
          Payment Method
        </div>

        <strong>
          ${escapeHtml(
            payment.paymentOption ||
            "—"
          )}
        </strong>


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
          class="primary-button"
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
          ${escapeHtml(item.fromUsername)}
          →
          ${escapeHtml(item.toUsername)}
        </strong>

        <div class="muted">
          ${isPayer
            ? `You owe ${escapeHtml(item.toUsername)}`
            : `${escapeHtml(item.fromUsername)} owes you`
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
        : Number(settlement.amount).toFixed(2);


    openModal(`

      <h2>
        Settle Up
      </h2>

      <p class="muted">

        You owe

        <strong>
          ${escapeHtml(settlement.toUsername)}
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

          ₱${Number(settlement.amount).toLocaleString(
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

                    <label
                      class="card"
                      style="
                        display:flex;
                        align-items:flex-start;
                        gap:12px;
                        cursor:pointer;
                        margin-top:10px;
                      "
                    >

                      <input
                        type="radio"
                        name="settlePaymentMethod"
                        value="${escapeHtml(detail.paymentDetailId)}"
                        ${
                          detail.isPreferred
                            ? "checked"
                            : ""
                        }
                        style="
                          width:auto;
                          margin-top:4px;
                        "
                      >

                      <div style="flex:1;">

                        <strong>
                          ${escapeHtml(
                            detail.paymentOption
                          )}
                        </strong>

                        ${
                          detail.accountNumber
                            ? `
                              <div class="muted">
                                ${escapeHtml(
                                  detail.accountNumber
                                )}
                              </div>
                            `
                            : ""
                        }

                        ${
                          detail.accountName
                            ? `
                              <div class="muted">
                                ${escapeHtml(
                                  detail.accountName
                                )}
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
                              <div
                                style="
                                  margin-top:12px;
                                  display:flex;
                                  flex-direction:column;
                                  align-items:flex-start;
                                  gap:8px;
                                "
                              >

                                <div
                                  class="muted"
                                  style="
                                    font-weight:600;
                                  "
                                >
                                  Payment QR Code
                                </div>

                                <a
                                  href="${escapeHtml(
                                    detail.qrDisplayUrl
                                  )}"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style="
                                    display:inline-block;
                                    text-decoration:none;
                                  "
                                >

                                  <img
                                    src="${escapeHtml(
                                      detail.qrDisplayUrl
                                    )}"
                                    alt="Payment QR Code"
                                    style="
                                      width:180px;
                                      height:180px;
                                      object-fit:contain;
                                      border:1px solid var(--border-color, #ddd);
                                      border-radius:12px;
                                      background:#fff;
                                      padding:8px;
                                      display:block;
                                    "
                                  >

                                </a>

                                <a
                                  href="${escapeHtml(
                                    detail.qrDisplayUrl
                                  )}"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  class="secondary-button"
                                  style="
                                    text-decoration:none;
                                  "
                                >
                                  View QR Code
                                </a>

                              </div>
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
                  settlement.toUsername
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
     * Check whether this settlement already
     * has a payment awaiting confirmation.
     */
      const { data: transactionPayments, error: transactionError } =
        await supabaseClient
          .from("payment_submissions")
          .select("*")
          .eq("group_id", settlement.groupId);

      if (transactionError) {
        throw transactionError;
      }

      const transactions =
        (transactionPayments || []).map(payment => ({
          type: "PAYMENT",
          status: payment.status,
          settlementId: payment.settlement_id,
          fromUserId: payment.payer_user_id,
          toUserId: payment.recipient_user_id,
          paymentSubmissionId: payment.id,
          amountPaid: Number(payment.amount_paid || 0)
        }));


    const existingPending =
      transactions.find(
        transaction =>

          String(
            transaction.type
          ).toUpperCase() ===
            "PAYMENT" &&

          String(
            transaction.status
          ).toUpperCase() ===
            "SUBMITTED" &&

          String(
            transaction.settlementId
          ) ===
            String(
              settlement.settlementId
            ) &&

          String(
            transaction.fromUserId
          ) ===
            String(
              state.user.userId
            )
      );


    /*
     * --------------------------------------------------
     * EXISTING PAYMENT
     * --------------------------------------------------
     *
     * If a payment already exists, attach the
     * payment proof instead of creating another
     * payment submission.
     */
    if (existingPending) {

      if (!proofFile) {

        toast(
          "You already have a payment awaiting confirmation for this settlement. Please attach the payment proof."
        );

        return;
      }


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


      const proofFileUrl =
        await uploadPaymentProofToSupabase(
          proof,
          settlement.groupId,
          settlement.settlementId
        );


      setLoading(
        true,
        "Attaching payment proof..."
      );


      const { error: proofUpdateError } =
        await supabaseClient
          .from("payment_submissions")
          .update({
            proof_file_url: proofFileUrl
          })
          .eq("id", existingPending.paymentSubmissionId)
          .eq("payer_user_id", state.user.userId);

      if (proofUpdateError) {
        throw proofUpdateError;
      }


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


      closeModal();


      await refreshCurrentGroup();


      toast(
        "Payment proof attached successfully."
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


    const { data: submission, error: submissionError } =
      await supabaseClient
        .from("payment_submissions")
        .insert({
          settlement_id: settlement.settlementId,
          group_id: settlement.groupId,
          payer_user_id: state.user.userId,
          recipient_user_id: settlement.toUserId,
          payment_option:
            selected.closest("label")?.querySelector(
              "strong"
            )?.textContent?.trim() ||
            selected.dataset?.paymentOption ||
            selected.value,
          payment_detail_id: paymentDetailId,
          amount_due: Number(settlement.amount),
          amount_paid: amountPaid,
          proof_file_url: proofFileUrl,
          notes: notes || "",
          status: "SUBMITTED"
        })
        .select()
        .single();

    if (submissionError) {
      throw submissionError;
    }

    /*
     * Keep a settlement record so the payment is tied
     * to the current debtor/creditor pair.
     */
    const { data: existingSettlement, error: settlementLookupError } =
      await supabaseClient
        .from("settlements")
        .select("id")
        .eq("group_id", settlement.groupId)
        .eq("from_user_id", state.user.userId)
        .eq("to_user_id", settlement.toUserId)
        .maybeSingle();

    if (settlementLookupError) {
      throw settlementLookupError;
    }

    if (!existingSettlement) {
      const { error: settlementInsertError } =
        await supabaseClient
          .from("settlements")
          .insert({
            group_id: settlement.groupId,
            from_user_id: state.user.userId,
            to_user_id: settlement.toUserId,
            amount: Number(settlement.amount),
            status: "PENDING"
          });

      if (settlementInsertError) {
        throw settlementInsertError;
      }
    }


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

function openMembersModal() {

  const members = state.currentGroup.members;

  openModal(`

    <h2>Members</h2>

    <div class="card">

      ${members.map(member => `

        <div class="member-row">

          <div>

            <div class="user-name">
              @${escapeHtml(member.username)}
            </div>

            <div class="user-handle">
              ${escapeHtml(member.displayName)}
            </div>

          </div>

          <small class="muted">
            ${escapeHtml(member.role)}
          </small>

        </div>

      `).join("")}

    </div>

    <div class="section-title">
      Add member
    </div>

    <form id="inviteMemberForm">

      <label>
        Username

        <div class="username-input">

          <span>@</span>

          <input
            id="inviteUsername"
            placeholder="username"
            required
          >

        </div>

      </label>

      <button
        class="primary-button"
        type="submit"
      >
        Send Invitation
      </button>

    </form>

  `);

  $("#inviteMemberForm").addEventListener(
    "submit",
    inviteMember
  );
}


async function inviteMember(event) {

  event.preventDefault();

  const username =
    $("#inviteUsername").value.trim();

  try {

    setLoading(true, "Sending invitation...");

    const {
      data: invitedProfile,
      error: profileError
    } = await supabaseClient
      .rpc("find_profile_by_username", {
        lookup_username: username
      });

    if (profileError) {
      throw profileError;
    }

    const targetProfile =
      Array.isArray(invitedProfile)
        ? invitedProfile[0]
        : invitedProfile;

    if (!targetProfile) {
      throw new Error("User not found.");
    }

    if (targetProfile.id === state.user.userId) {
      throw new Error("You cannot invite yourself.");
    }

    const { data: existingMember, error: memberError } =
      await supabaseClient
        .from("group_members")
        .select("user_id")
        .eq("group_id", state.currentGroup.group.groupId)
        .eq("user_id", targetProfile.id)
        .eq("status", "ACTIVE")
        .maybeSingle();

    if (memberError) {
      throw memberError;
    }

    if (existingMember) {
      throw new Error("This user is already a member of this group.");
    }

    const { data: existingInvitation, error: existingInvitationError } =
      await supabaseClient
        .from("invitations")
        .select("id")
        .eq("group_id", state.currentGroup.group.groupId)
        .eq("invited_user_id", targetProfile.id)
        .eq("status", "PENDING")
        .maybeSingle();

    if (existingInvitationError) {
      throw existingInvitationError;
    }

    if (existingInvitation) {
      throw new Error("An invitation is already pending.");
    }

    const { error: invitationError } =
      await supabaseClient
        .from("invitations")
        .insert({
          group_id: state.currentGroup.group.groupId,
          invited_user_id: targetProfile.id,
          invited_by_user_id: state.user.userId,
          status: "PENDING"
        });

    if (invitationError) {
      throw invitationError;
    }

    closeModal();

    toast("Invitation sent.");

  } catch (error) {

    toast(error.message);

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

  state.invitations =
    (invitationRows || []).map(invitation => ({
      invitationId: invitation.id,
      groupId: invitation.group_id,
      invitedUserId: invitation.invited_user_id,
      invitedByUserId: invitation.invited_by_user_id,
      status: invitation.status,
      createdAt: invitation.created_at,
      respondedAt: invitation.responded_at,
      groupName: invitation.groups?.group_name || "Group"
    }));

  $("#content").innerHTML = `

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
        <div class="action-row">

          <button
            class="action-button green-button"
            onclick="respondInvitation(
              '${escapeHtml(invitation.invitationId)}',
              'accept'
            )"
          >
            Accept
          </button>

          <button
            class="action-button red-button"
            onclick="respondInvitation(
              '${escapeHtml(invitation.invitationId)}',
              'decline'
            )"
          >
            Decline
          </button>

        </div>
      `
      : `
        <div class="invitation-status ${status === "ACCEPTED" ? "accepted" : "declined"}">
          ${
            status === "ACCEPTED"
              ? "Invitation Accepted"
              : "Invitation Declined"
          }
        </div>
      `;

  return `

    <div class="card">

      <div class="card-title">
        You were invited to join
        ${escapeHtml(invitation.groupName)}
      </div>

      <p class="muted">
        Invited by
        @${escapeHtml(invitation.invitedByUsername)}
      </p>

      ${actions}

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
    .order("provider_name");

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

    <div class="card">

      <div class="card-title">
        @${escapeHtml(state.user.username)}
      </div>

      <p class="muted">
        ${escapeHtml(state.user.email)}
      </p>

      <form id="profileForm">

        <label>
          Display name

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

    </div>


    <div class="card">

      <div class="card-title">
        Change password
      </div>

      <br>

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
          class="secondary-button"
          type="submit"
        >
          Change Password
        </button>

      </form>

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

      <button
        class="danger-button"
        onclick="logout()"
      >
        Log Out
      </button>

    </div>

  `;


  $("#profileForm").addEventListener(
    "submit",
    updateProfile
  );


  $("#passwordForm").addEventListener(
    "submit",
    changePassword
  );


  $("#addPaymentDetailsButton").addEventListener(
    "click",
    openPaymentDetailsForm
  );


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

    console.error("PROFILE RENDER ERROR:", error);

    $("#content").innerHTML = `
      <div class="card">
        <div class="card-title">Profile Error</div>
        <p class="muted">
          ${escapeHtml(error.message || String(error))}
        </p>
      </div>
    `;

    throw error;
  }

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
            class="card"
            style="margin-top:12px"
          >

            <div
              style="
                display:flex;
                justify-content:space-between;
                gap:12px;
                align-items:flex-start;
              "
            >

              <div>

                <div class="card-title">
                  ${escapeHtml(detail.paymentOption)}
                </div>

                ${
                  detail.paymentOption === "Cash"
                    ? `
                      <p class="muted">
                        Cash payment
                      </p>
                    `
                    : `
                      <p class="muted">
                        ${escapeHtml(detail.accountName)}
                      </p>

                      <p class="muted">
                        ${escapeHtml(detail.accountNumber)}
                      </p>
                    `
                }

                ${
                  detail.qrDisplayUrl
                    ? `
                      <div
                        style="
                          margin-top:12px;
                          display:flex;
                          flex-direction:column;
                          align-items:flex-start;
                          gap:8px;
                        "
                      >

                        <div
                          class="muted"
                          style="font-weight:600;"
                        >
                          Payment QR Code
                        </div>

                        <a
                          href="${escapeHtml(detail.qrDisplayUrl)}"
                          target="_blank"
                          rel="noopener noreferrer"
                          style="
                            display:inline-block;
                            text-decoration:none;
                          "
                        >

                          <img
                            src="${escapeHtml(detail.qrDisplayUrl)}"
                            alt="Payment QR Code"
                            style="
                              width:180px;
                              height:180px;
                              object-fit:contain;
                              border:1px solid var(--border-color, #ddd);
                              border-radius:12px;
                              background:#fff;
                              padding:8px;
                              display:block;
                            "
                          >

                        </a>

                        <a
                          href="${escapeHtml(detail.qrDisplayUrl)}"
                          target="_blank"
                          rel="noopener noreferrer"
                          class="secondary-button"
                          style="text-decoration:none;"
                        >
                          View QR Code
                        </a>

                      </div>
                    `
                    : ""
                }

              </div>


              <div
                style="
                  display:flex;
                  flex-direction:column;
                  align-items:flex-end;
                  gap:8px;
                "
              >

                ${
                  detail.isPreferred
                    ? `
                      <span class="muted">
                        Preferred
                      </span>
                    `
                    : ""
                }

                <div
                  style="
                    display:flex;
                    gap:8px;
                  "
                >

                  ${
                    detail.qrFileUrl
                      ? `
                        <button
                          type="button"
                          class="secondary-button"
                          onclick="viewPaymentQr('${detail.paymentDetailId}')"
                        >
                          View
                        </button>
                      `
                      : ""
                  }

                  <button
                    type="button"
                    class="secondary-button"
                    onclick="editPaymentDetails('${detail.paymentDetailId}')"
                  >
                    Edit
                  </button>

                  <button
                    type="button"
                    class="danger-button"
                    onclick="deletePaymentDetails('${detail.paymentDetailId}')"
                  >
                    Delete
                  </button>

                </div>

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

    window.open(signedUrl, "_blank", "noopener,noreferrer");
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
          class="primary-button"
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


function openModal(html) {

  $("#modalContent").innerHTML = `
    <button
      type="button"
      class="modal-close"
      aria-label="Close"
      onclick="closeModal()"
    >
      &times;
    </button>
    ${html}
  `;

  $("#modal").classList.remove("hidden");

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
