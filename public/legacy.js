window.onerror = function(msg, src, line, col, err) {
  console.error('GLOBAL ERROR:', msg, 'line:', line, 'col:', col);
  var d = document.createElement('div');
  d.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#9B2C2C;color:#fff;padding:10px 16px;font-size:12px;font-family:monospace;z-index:99999;';
  d.textContent = 'JS Error line ' + line + ': ' + msg;
  document.body && document.body.appendChild(d);
  return false;
};
// ── Supabase Init ────────────────────────────────────────────
const SUPABASE_URL = 'https://mwwqeakjxmpticvbpinc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im13d3FlYWtqeG1wdGljdmJwaW5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NjIxMjUsImV4cCI6MjA5MjUzODEyNX0.sqOElnGDRM2X2-TT1iMrnPBa_HK0ndDZ_31iP40jsiE';
var sb = null; // supabase client
var currentUser = null;
var currentProfile = null; // manager_profiles row

function initSupabase() {
  if (window.supabase) {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    // Check for existing session first
    sb.auth.getSession().then(async function(result) {
      if (result.data && result.data.session) {
        currentUser = result.data.session.user;
        await loadUserProfile();
      } else {
        showAuthOverlay();
      }
    });
    // Listen for future auth changes
    sb.auth.onAuthStateChange(async function(event, session) {
      if (event === 'SIGNED_IN' && session && session.user) {
        currentUser = session.user;
        await loadUserProfile();
      } else if (event === 'TOKEN_REFRESHED' && session && session.user) {
        currentUser = session.user;
        updateUserBadge();
      } else if (event === 'SIGNED_OUT') {
        // Verify session is truly gone before showing auth overlay
        var check = await sb.auth.getSession();
        if (check.data && check.data.session) return; // still have a session, ignore
        currentUser = null;
        currentProfile = null;
        localStorage.removeItem('pf-current-email');
        localStorage.removeItem('pf-current-role');
        showAuthOverlay();
      }
    });
  }
}

async function loadUserProfile() {
  if (!sb || !currentUser) return;
  try {
    // Add a 5 second timeout to prevent hanging
    var fetchPromise = sb.from('manager_profiles').select('*').eq('id', currentUser.id).maybeSingle();
    var timeoutPromise = new Promise(function(_, reject) {
      setTimeout(function() { reject(new Error('Profile fetch timed out')); }, 5000);
    });
    var r = await Promise.race([fetchPromise, timeoutPromise]);
    var emailEl = document.getElementById('user-email-display');
    var roleEl  = document.getElementById('user-role-display');
    if (emailEl) emailEl.textContent = currentUser.email;
    if (r && r.data) {
      currentProfile = r.data;
      updateUserBadge();
      applyRoleRestrictions();
    } else {
      if (roleEl) roleEl.textContent = currentUser.email;
    }
  } catch(e) {
    console.warn('Profile load failed:', e.message);
  }
  // Always update badge with email even if profile didn't load
  // Always update badge
  updateUserBadge();
  // Always hide the auth overlay and apply restrictions
  hideAuthOverlay();
  applyRoleRestrictions();
  bankLoad();
  actLoad();
}

function updateUserBadge() {
  var emailEl = document.getElementById('user-email-display');
  var roleEl  = document.getElementById('user-role-display');
  // Always persist whatever we have
  if (currentUser && currentUser.email) localStorage.setItem('pf-current-email', currentUser.email);
  if (currentProfile) localStorage.setItem('pf-current-role', JSON.stringify(currentProfile));
  // Use live data first, fall back to cache — badge never clears unless explicit sign-out
  var cachedProfile = null;
  try { cachedProfile = JSON.parse(localStorage.getItem('pf-current-role')||'null'); } catch(e) {}
  var profile = currentProfile || cachedProfile;
  var email   = (currentUser && currentUser.email) || localStorage.getItem('pf-current-email') || '';
  if (emailEl && email) emailEl.textContent = email;
  if (roleEl && profile) {
    roleEl.textContent = profile.role === 'admin'
      ? 'Admin — full access'
      : 'Manager — ' + (profile.departments||[]).join(', ');
  } else if (roleEl && email) {
    roleEl.textContent = 'Signed in';
  }
  // Restore currentProfile from cache if missing (e.g. after token refresh)
  if (!currentProfile && cachedProfile) currentProfile = cachedProfile;
}

function applyRoleRestrictions() {
  var isExplicitlyNotAdmin = currentProfile && currentProfile.role !== 'admin';
  // Add Goal button visible for all authenticated users
  document.querySelectorAll('.add-goal-btn').forEach(function(btn) {
    btn.style.display = '';
  });
  // Hide Rippling Data nav item for non-admins (upload is admin-only)
  var ripplingNav = document.getElementById('nav-item-rippling');
  if (ripplingNav) ripplingNav.style.display = isExplicitlyNotAdmin ? 'none' : '';
  // If currently on rippling screen and not admin, redirect home
  if (isExplicitlyNotAdmin && currentMode === 'rippling') switchMode('landing');
}

function showAuthOverlay() {
  var overlay = document.getElementById('auth-overlay');
  if (overlay) overlay.style.display = 'flex';
  var badge = document.getElementById('user-badge');
  if (badge) badge.style.display = 'none';
}

function hideAuthOverlay() {
  var overlay = document.getElementById('auth-overlay');
  if (overlay) overlay.style.display = 'none';
  updateUserBadge();
}

async function authSignIn() {
  var email    = document.getElementById('auth-email').value.trim();
  var password = document.getElementById('auth-password').value;
  var errEl    = document.getElementById('auth-error');
  var btn      = document.getElementById('auth-btn');
  if (!email || !password) { errEl.textContent='Enter email and password'; errEl.style.display='block'; return; }
  if (!sb) { errEl.textContent='Connection error — please reload the page and try again'; errEl.style.display='block'; return; }
  btn.textContent = 'Signing in...'; btn.disabled = true;
  try {
    var r = await sb.auth.signInWithPassword({ email: email, password: password });
    btn.textContent = 'Sign In'; btn.disabled = false;
    if (r.error) {
      var msg = r.error.message;
      if (msg.includes('Email not confirmed')) msg = 'Email not confirmed — ask your admin to disable email confirmation in Supabase.';
      if (msg.includes('Invalid login')) msg = 'Incorrect email or password.';
      errEl.textContent = msg; errEl.style.display = 'block';
    } else {
      errEl.style.display = 'none';
    }
  } catch(e) {
    btn.textContent = 'Sign In'; btn.disabled = false;
    errEl.textContent = 'Connection failed: ' + e.message;
    errEl.style.display = 'block';
  }
}

async function authSignOut() {
  localStorage.removeItem('pf-current-email');
  localStorage.removeItem('pf-current-role');
  currentProfile = null;
  currentUser = null;
  if (sb) await sb.auth.signOut();
  showAuthOverlay();
  // Clear badge
  var emailEl = document.getElementById('user-email-display');
  var roleEl  = document.getElementById('user-role-display');
  if (emailEl) emailEl.textContent = 'Not signed in';
  if (roleEl)  roleEl.textContent  = '';
  // Clear password field
  var pwEl = document.getElementById('auth-password');
  if (pwEl) pwEl.value = '';
}

// ── Supabase Data Functions ──────────────────────────────────

// Goal Bank
async function sbLoadGoalBank() {
  if (!sb) return null;
  var r = await sb.from('goals_bank').select('*').order('goal_tier').order('department').order('name');
  return r.data || null;
}

async function sbSaveGoal(goal, id) {
  if (!sb) return null;
  var row = {
    goal_tier: goal.goalTier, location: goal.location||null, department: goal.department||null,
    role: goal.role||null, name: goal.name, goal_value: goal.goalValue, min_value: goal.minValue,
    lower_better: goal.lowerBetter!==false, capped: goal.capped||'no', cap_pct: goal.capPct||100,
    active: goal.active!==false
  };
  if (id) {
    return await sb.from('goals_bank').update(row).eq('id', id);
  } else {
    return await sb.from('goals_bank').insert(row).select().single();
  }
}

async function sbDeleteGoal(id) {
  if (!sb) return;
  return await sb.from('goals_bank').delete().eq('id', id);
}

async function sbToggleGoalActive(id, active) {
  if (!sb) return;
  return await sb.from('goals_bank').update({ active: active }).eq('id', id);
}

// Actuals
async function sbLoadActuals(period) {
  if (!sb) return {};
  var r = await sb.from('actuals').select('*').eq('period', period);
  var map = {};
  (r.data||[]).forEach(function(a) {
    var gn = a.goal_name || '';
    if (gn.indexOf('__target__') === 0 || gn.indexOf('__min__') === 0) {
      // Return as-is for target/min entries
      map[gn] = a.actual_value;
    } else {
      var key = [a.goal_tier, a.location||'', a.department||'', gn].join('|');
      map[key] = a.actual_value;
    }
  });
  return map;
}

async function sbSaveActual(period, key, value) {
  if (!sb) return;
  var row;
  if (key.indexOf('__target__') === 0 || key.indexOf('__min__') === 0) {
    // Month target/min stored as special actuals
    // key format: '__target__goalName|tier' or '__min__goalName|tier'
    var isTarget = key.indexOf('__target__') === 0;
    var inner = key.replace('__target__','').replace('__min__','');
    var pipIdx = inner.lastIndexOf('|');
    var goalName = pipIdx > -1 ? inner.substring(0, pipIdx) : inner;
    var tier = pipIdx > -1 ? inner.substring(pipIdx+1) : '';
    row = {
      period: period,
      goal_tier: tier || '__meta__',
      location: null,
      department: null,
      goal_name: (isTarget ? '__target__' : '__min__') + goalName,
      actual_value: value
    };
  } else {
    // Regular actual: key format 'tier|location|department|goalName'
    var parts = key.split('|');
    row = {
      period: period,
      goal_tier: parts[0] || '',
      location: parts[1] || null,
      department: parts[2] || null,
      goal_name: parts[3] || key,
      actual_value: value
    };
  }
  return await sb.from('actuals').upsert(row, { onConflict: 'period,goal_tier,location,department,goal_name' });
}

// Rippling employees
async function sbSaveRippling(period, employees) {
  if (!sb) return;
  // Delete existing for this period then insert fresh
  await sb.from('rippling_employees').delete().eq('period', period);
  var rows = employees.map(function(e) {
    return {
      period: period, full_name: e.name, role: e.role, department: e.department,
      location: e.location, manager: e.manager||null, pay_type: e.payType,
      hourly_rate: e.hourlyRate||null, annual_pay: e.annualPay||null,
      gross_earnings: e.grossEarnings||null, hours_worked: e.hoursWorked||null,
      is_exempt: e.isExempt||false, employment_type: e.employmentType||null
    };
  });
  return await sb.from('rippling_employees').insert(rows);
}

async function sbLoadRippling(period) {
  if (!sb) return [];
  var r = await sb.from('rippling_employees').select('*').eq('period', period);
  return (r.data||[]).map(function(e) {
    return {
      name: e.full_name, role: e.role, department: e.department,
      location: e.location, manager: e.manager, payType: e.pay_type,
      hourlyRate: e.hourly_rate, annualPay: e.annual_pay,
      grossEarnings: e.gross_earnings, hoursWorked: e.hours_worked,
      isExempt: e.is_exempt, employmentType: e.employment_type
    };
  });
}

async function sbLoadRipplingPeriods() {
  if (!sb) return [];
  var r = await sb.from('rippling_employees').select('period').order('period', {ascending: false});
  var seen = {};
  return (r.data||[]).filter(function(x) { if(seen[x.period]) return false; seen[x.period]=true; return true; }).map(function(x){return x.period;});
}

// Scorecards
async function sbSaveScorecard(payload) {
  if (!sb) return;
  var row = {
    employee_name: payload.employeeName, role: payload.role, department: payload.department,
    location: payload.location, manager: payload.manager, pay_type: payload.payType,
    hourly_rate: payload.hourlyRate||null, hours_worked: payload.hours||null,
    annual_pay: payload.annualPay||null, base_earnings: payload.baseEarnings,
    bonus_potential_pct: payload.bonusPotentialPct||10, scorecard_month: payload.scorecardMonth,
    period_type: payload.scorecardPeriodType||'monthly', weighted_achievement: payload.weightedAchievement,
    bonus_amount: payload.bonusAmount, scorecard_capped: payload.scorecardCapped||false,
    flag_120: payload.flag120||false, goals: payload.goals,
    submitted_by: currentUser ? currentUser.email : null
  };
  return await sb.from('scorecards').insert(row).select().single();
}

async function sbLoadScorecards(filters) {
  if (!sb) return [];
  var q = sb.from('scorecards').select('*').order('scorecard_month', {ascending:false}).order('employee_name');
  if (filters && filters.period) q = q.eq('scorecard_month', filters.period);
  if (filters && filters.location) q = q.eq('location', filters.location);
  if (filters && filters.department) q = q.eq('department', filters.department);
  if (filters && filters.search) {
    q = q.or('employee_name.ilike.*' + filters.search + '*,department.ilike.*' + filters.search + '*,location.ilike.*' + filters.search + '*,role.ilike.*' + filters.search + '*');
  }
  // Non-admins: restrict to their departments/locations
  if (currentProfile && currentProfile.role !== 'admin') {
    var depts = currentProfile.departments || [];
    var locs  = currentProfile.locations  || [];
    if (depts.length) q = q.in('department', depts);
  }
  var r = await q;
  return (r.data||[]).map(function(sc) {
    return {
      employeeName: sc.employee_name, role: sc.role, department: sc.department,
      location: sc.location, manager: sc.manager, payType: sc.pay_type,
      hourlyRate: sc.hourly_rate, hours: sc.hours_worked, annualPay: sc.annual_pay,
      baseEarnings: sc.base_earnings, bonusPotentialPct: sc.bonus_potential_pct,
      scorecardMonth: sc.scorecard_month, _month: sc.scorecard_month,
      weightedAchievement: sc.weighted_achievement, bonusAmount: sc.bonus_amount,
      scorecardCapped: sc.scorecard_capped, flag120: sc.flag_120, goals: sc.goals,
      submittedAt: sc.submitted_at, submittedBy: sc.submitted_by, _id: sc.id
    };
  });
}

async function sbDeleteScorecard(id) {
  if (!sb) return;
  return await sb.from('scorecards').delete().eq('id', id);
}


// ── Local Storage Backend (replaces Google Apps Script) ────────
var SCRIPT_URL = ''; // no longer used

function goalsKey(month) { return 'goals:' + month; }
function scorecardsKey(month) { return 'scorecards:' + month; }

// Storage with localStorage fallback
function hasWindowStorage() {
  return typeof window !== 'undefined' && window.storage && typeof window.storage.get === 'function';
}

async function storageGet(key) {
  var windowVal = null;
  var localVal = localStorage.getItem(key);

  if (window.storage && typeof window.storage.get === 'function') {
    try {
      var r = await window.storage.get(key, true);
      if (r && r.value) windowVal = r.value;
    } catch(e) {}
  }

  // Prefer window.storage if it has real data (non-empty array)
  if (windowVal && windowVal !== '[]' && windowVal !== 'null') return windowVal;
  // Fall back to localStorage if it has real data
  if (localVal && localVal !== '[]' && localVal !== 'null') return localVal;
  // Return whichever exists, even if empty
  if (windowVal !== null) return windowVal;
  return localVal;
}

async function storageSet(key, val) {
  try {
    if (window.storage && typeof window.storage.set === 'function') {
      await window.storage.set(key, val, true);
      return;
    }
  } catch(e) { }
  localStorage.setItem(key, val);
}

function getOldMonthKey(month) {
  // Generate the UTC-shifted key that was used before the timezone fix
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var parts = month.split(' ');
  var monthIdx = months.indexOf(parts[0]);
  var year = parseInt(parts[1]);
  if (monthIdx < 0 || !year) return null;
  // Simulate old UTC parsing: subtract a day to get what new Date('YYYY-MM-01') would produce in UTC-7
  var utcDate = new Date(Date.UTC(year, monthIdx, 1));
  var localDate = new Date(utcDate.getTime() - (7 * 60 * 60 * 1000)); // UTC-7 offset
  var oldLabel = localDate.toLocaleString('default', { month: 'long', year: 'numeric' });
  return oldLabel !== month ? oldLabel : null;
}

async function storageGetGoals(month) {
  try {
    var r = await storageGet(goalsKey(month));
    if (r) return JSON.parse(r);
    return [];
  } catch(e) { return []; }
}
async function storageSaveGoals(month, arr) {
  await storageSet(goalsKey(month), JSON.stringify(arr));
}
async function storageGetScorecards(month) {
  try {
    var r = await storageGet(scorecardsKey(month));
    if (r) return JSON.parse(r);
    return [];
  } catch(e) { return []; }
}
async function storageSetScorecards(month, arr) {
  await storageSet(scorecardsKey(month), JSON.stringify(arr));
  // Maintain a months index so we can list all months without window.storage.list
  try {
    var indexKey = 'scorecards-months-index';
    var existing = await storageGet(indexKey);
    var months = existing ? JSON.parse(existing) : [];
    if (months.indexOf(month) === -1) {
      months.push(month);
      await storageSet(indexKey, JSON.stringify(months));
    }
  } catch(e) {}
}

function escAttr(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showToast(msg, type) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(function() { t.className = 'toast'; }, 3000);
}

function fmt(n) {
  return parseFloat(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
}

var DEPT_ROLES_MAP = {
  "Client Care": ["Client Care Manager","Client Care Specialist","Client Experience Manager","Senior Client Care Specialist"],
  "Design": ["Design Specialist","Design Team Manager","Senior Design Specialist"],
  "Experience": ["Director of Product & Client Experience","Product & Design Lead","UX Design Specialist"],
  "Fulfillment": ["Fulfillment Specialist","Fulfillment Team Manager","Senior Fulfillment Specialist"],
  "General & Administrative": ["Human Resources Manager"],
  "Growth": ["Business Development Manager"],
  "Marketing": ["Community Specialist","Head of Marketing","Social Media Manager","Social Media Specialist"],
  "Operations": ["Director of Operations","General Manager","Head of Preservation & Design"],
  "Preservation": ["Head of Preservation & Design","Preservation Specialist","Preservation Team Manager","Senior Preservation Specialist"],
  "Recreation": [],
  "Resin": ["Resin Design Specialist","Resin Team Manager","Senior Resin Design Specialist"]
};

var ROLE_DEPT_MAP = {"Business Development Manager": "Growth", "Client Care Manager": "Client Care", "Client Care Specialist": "Client Care", "Client Experience Manager": "Client Care", "Community Specialist": "Marketing", "Design Specialist": "Design", "Design Team Manager": "Design", "Director of Operations": "Operations", "Director of Product & Client Experience": "Experience", "Fulfillment Specialist": "Fulfillment", "Fulfillment Team Manager": "Fulfillment", "General Manager": "Operations", "Head of Marketing": "Marketing", "Head of Preservation & Design": "Operations", "Human Resources Manager": "General & Administrative", "Preservation Specialist": "Preservation", "Preservation Team Manager": "Preservation", "Product & Design Lead": "Experience", "Resin Design Specialist": "Resin", "Resin Team Manager": "Resin", "Senior Client Care Specialist": "Client Care", "Senior Design Specialist": "Design", "Senior Fulfillment Specialist": "Fulfillment", "Senior Preservation Specialist": "Preservation", "Senior Resin Design Specialist": "Resin", "Social Media Manager": "Marketing", "Social Media Specialist": "Marketing", "UX Design Specialist": "Experience"};

function onSetupDeptChange() {
  var dept = document.getElementById('setup-dept').value;
  var roleSelect = document.getElementById('setup-role');
  var currentRole = roleSelect.value;
  roleSelect.innerHTML = '<option value="">Select role</option>';
  var roles = dept && DEPT_ROLES_MAP[dept] ? DEPT_ROLES_MAP[dept] : [];
  roles.forEach(function(r) {
    var opt = document.createElement('option');
    opt.value = r; opt.textContent = r;
    if (r === currentRole) opt.selected = true;
    roleSelect.appendChild(opt);
  });
  if (roles.length === 0 && dept) {
    var opt = document.createElement('option');
    opt.value = ''; opt.textContent = 'No roles defined for this department';
    roleSelect.appendChild(opt);
  }
  loadSetupPresetGoals();
  loadSavedGoalsPreview();
  loadSetupTierGoalPreviews();
  loadSetupPeriodOverview();
}

function onSetupRoleChange() {
  loadSetupPresetGoals();
  loadSavedGoalsPreview();
  loadSetupTierGoalPreviews();
}

function inferTier(g) {
  if (!g.location && !g.department && !g.role) return 'company';
  if (g.location && g.department && !g.role) return 'department';
  return 'individual';
}
function inferTierFromPayload(p) {
  if (!p.location && !p.department && !p.role) return 'company';
  if (p.location && p.department && !p.role) return 'department';
  return 'individual';
}

async function apiGetGoals(params) {
  var goals = await storageGetGoals(params.month);
  var filtered = goals.filter(function(g) {
    var tier = g.goalTier || inferTier(g);
    // If a specific tier is requested, only return that tier
    if (params.goalTier) return tier === params.goalTier &&
      (tier === 'company' ? true :
       tier === 'department' ? (g.location === params.location && g.department === params.department) :
       (g.location === params.location && g.department === params.department && (!params.role || g.role === params.role)));
    // No tier filter — match by location/dept/role across all tiers
    if (tier === 'company') return true;
    if (tier === 'department') return g.location === params.location && g.department === params.department;
    return g.location === params.location && g.department === params.department && (!params.role || g.role === params.role);
  });
  return { goals: filtered.map(function(g) {
    return { name: g.name, weight: g.weight, goalValue: g.goalValue, minValue: g.minValue,
      capped: g.capped||'no', capPct: g.capPct||100, lowerBetter: g.lowerBetter!==false,
      goalTier: g.goalTier||inferTier(g), storedActual: g.storedActual||null };
  }), bonusPot: 10 };
}

async function apiGetRoles(params) {
  var goals = await storageGetGoals(params.month);
  goals.forEach(function(g) { });
  var roles = [], seen = {};
  goals.forEach(function(g) {
    var tier = g.goalTier||inferTier(g);
    if (tier==='individual' && g.location===params.location && g.department===params.department && g.role && !seen[g.role]) {
      roles.push(g.role); seen[g.role]=true;
    }
  });
  return { roles: roles };
}

async function apiSaveGoals(payload) {
  var month = payload.scorecardMonth;
  var goals = await storageGetGoals(month);
  var tier = payload.goalTier || inferTierFromPayload(payload);
  // Remove ALL existing goals matching this exact tier+location+dept+role combo
  goals = goals.filter(function(g) {
    var gt = g.goalTier || inferTier(g);
    if (gt !== tier) return true; // keep other tiers
    if (tier === 'company') return false; // remove all company goals
    if (tier === 'department') return !(g.location === (payload.location||'') && g.department === (payload.department||''));
    return !(g.location === (payload.location||'') && g.department === (payload.department||'') && g.role === (payload.role||''));
  });
  // Add new goals
  (payload.goals||[]).forEach(function(g) {
    goals.push({
      location: payload.location||'', department: payload.department||'', role: payload.role||'',
      name: g.name, weight: g.weight, goalValue: g.goalValue, minValue: g.minValue,
      bonusPot: payload.bonusPot||10, savedAt: new Date().toISOString(),
      capped: g.capped||'no', capPct: g.capPct||100, lowerBetter: g.lowerBetter!==false,
      goalTier: tier, storedActual: null
    });
  });
  await storageSaveGoals(month, goals);
  return { status: 'ok' };
}

async function clearGoalsForMonth(month) {
  await storageSaveGoals(month, []);
}

async function apiCheckGoals(params) {
  var goals = await storageGetGoals(params.month);
  var tier = params.goalTier||'individual';
  var exists = goals.some(function(g) {
    var gt = g.goalTier||inferTier(g);
    if (gt!==tier) return false;
    if (tier==='company') return true;
    if (tier==='department') return g.location===params.location && g.department===params.department;
    return g.location===params.location && g.department===params.department && g.role===params.role;
  });
  return { exists: exists };
}

async function apiSaveScorecard(payload) {
  var month = payload.scorecardMonth;
  var scorecards = await storageGetScorecards(month);
  scorecards = scorecards.filter(function(s) { return s.employeeName!==payload.employeeName; });
  scorecards.push(payload);
  await storageSetScorecards(month, scorecards);
  return { status: 'ok' };
}

async function apiCheckActuals(params) {
  var scorecards = await storageGetScorecards(params.period);
  var exists = scorecards.some(function(s) { return s.employeeName===params.employeeName; });
  return { exists: exists };
}

async function apiSaveTierActuals(payload) {
  var month = payload.scorecardMonth;
  var goals = await storageGetGoals(month);
  var tier = payload.goalTier;
  (payload.results||[]).forEach(function(result) {
    goals.forEach(function(g) {
      var gt = g.goalTier||inferTier(g);
      if (gt!==tier) return;
      if (tier==='department' && (g.location!==payload.location||g.department!==payload.department)) return;
      if (g.name===result.name) g.storedActual = result.actual;
    });
  });
  await storageSaveGoals(month, goals);
  return { status: 'ok' };
}

function downloadCSV(rows, filename) {
  var csv = rows.map(function(r) {
    return r.map(function(cell) {
      var s = String(cell===null||cell===undefined?'':cell);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    }).join(',');
  }).join('\n');
  var blob = new Blob([csv], {type:'text/csv'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

async function exportGoalsCSV(month) {
  var goals = await storageGetGoals(month);
  if (!goals.length) { showToast('No goals found for ' + month, 'error'); return; }
  var rows = [['Location','Department','Role','Goal Name','Weight (%)','Goal Value','Min Performance','Capped','Cap %','Lower is Better','Goal Tier','Stored Actual']];
  goals.forEach(function(g) { rows.push([g.location,g.department,g.role,g.name,g.weight,g.goalValue,g.minValue,g.capped,g.capPct,g.lowerBetter?'Yes':'No',g.goalTier||inferTier(g),g.storedActual||'']); });
  downloadCSV(rows, 'goals-' + month.replace(' ','-') + '.csv');
}

async function exportScorecardsCSV(month) {
  var scorecards = await storageGetScorecards(month);
  if (!scorecards.length) { showToast('No scorecards found for ' + month, 'error'); return; }
  var rows = [['Employee','Role','Department','Location','Manager','Pay Type','Base Earnings','Bonus Amount','Weighted Achievement','Period']];
  scorecards.forEach(function(s) { rows.push([s.employeeName,s.role,s.department,s.location,s.manager,s.payType||'hourly',s.baseEarnings,s.bonusAmount,s.weightedAchievement,s.scorecardMonth]); });
  downloadCSV(rows, 'scorecards-' + month.replace(' ','-') + '.csv');
}

// ── State ──────────────────────────────────────────────────────
var goals = [];
var setupGoals = [];
var nextId = 1;
var lastResults = null;
var currentMode = 'setup';
var goalsLoaded = false;

// ── Mode switching ─────────────────────────────────────────────
function updateHeaderLabel() {
  var label = document.getElementById('header-period-label');
  if (!label) return;
  var periodType = currentMode === 'setup' ? setupPeriodType : actualsPeriodType;
  label.textContent = periodType === 'quarterly' ? 'Quarterly' : 'Monthly';
}

function switchMode(mode) {
  currentMode = mode;
  ['landing','setup','history','rippling','guide','scorecard','migrate','todos'].forEach(function(m) {
    var screen = document.getElementById('screen-' + m);
    if (screen) screen.className = 'screen' + (m === mode ? ' active' : '');
    var navItem = document.getElementById('nav-item-' + m);
    if (navItem) navItem.className = 'nav-item' + (m === mode ? ' active' : '');
  });
  // Update header label
  var labels = { setup:'Goals & Actuals', history:'Historical Data', rippling:'Rippling Data', guide:'How To Use', scorecard:'Team Scorecards', landing:'Home' };
  var label = document.getElementById('current-page-label');
  if (label) label.textContent = labels[mode] || 'Home';
  if (mode === 'setup') { bankLoad().catch(function(e){ console.error('bankLoad failed:', e); }); }
  if (mode === 'history') { historyPopulateGoals(); }
  if (mode === 'todos') { renderTodos(); }
  if (mode === 'scorecard') { initTeamScorecards(); }
  
  if (mode === 'history') { _historyAll = []; _historyFiltered = []; var hrs = document.getElementById('history-results-section'); if(hrs) hrs.style.display='none'; var hes = document.getElementById('history-empty-section'); if(hes) hes.style.display='none'; }
  if (mode === 'rippling') loadRipplingSaved();
}

// ── Setup goals ────────────────────────────────────────────────
function addSetupGoal(name, goal, min, weight, lowerBetter, capped, capPct) {
  var id = nextId++;
  setupGoals.push({ id: id, name: name || '', goal: goal || '', min: min || '', weight: weight || '', lowerBetter: (lowerBetter !== undefined && lowerBetter !== null) ? lowerBetter : null, capped: (capped !== undefined && capped !== null) ? capped : null, capPct: capPct || '100' });
  renderSetupGoals();
}

function removeSetupGoal(id) {
  setupGoals = setupGoals.filter(function(g) { return g.id !== id; });
  renderSetupGoals();
}

function updateSetupGoal(id, field, val) {
  // Convert boolean fields
  if (field === 'lowerBetter') val = (val === 'true' || val === true);
  for (var i = 0; i < setupGoals.length; i++) {
    if (setupGoals[i].id === id) { setupGoals[i][field] = val; break; }
  }
  // Re-render only when capped changes (shows/hides cap% field)
  // All other fields just recalc — don't re-render or focus is lost
  if (field === 'capped') {
    renderSetupGoals();
  } else {
    calcSetupWeights();
  }
}

function renderSetupGoals() {
  var c = document.getElementById('setup-goals-container');
  c.innerHTML = '';
  for (var i = 0; i < setupGoals.length; i++) {
    var g = setupGoals[i];
    var isCapped = g.capped === 'yes';
    var div = document.createElement('div');
    div.className = 'goal-card';
    div.innerHTML =
      '<div class="goal-header">' +
        '<span style="font-family:var(--mono);font-size:11px;color:var(--text-muted);">Goal ' + (i+1) + '</span>' +
        '<button class="remove-goal" data-id="' + g.id + '">&times;</button>' +
      '</div>' +
      '<div class="fields-grid">' +
        '<div class="field half"><label>Goal name</label>' +
          '<input type="text" placeholder="' + (goalTier === 'company' ? 'e.g. Client Satisfaction' : goalTier === 'department' ? 'e.g. Department Goal' : 'e.g. Individual Ratio') + '" value="' + escAttr(g.name) + '" data-id="' + g.id + '" data-field="name"></div>' +
        '<div class="field"><label>Goal target</label>' +
          '<input type="number" step="any" placeholder="e.g. 2.00" value="' + escAttr(g.goal) + '" data-id="' + g.id + '" data-field="goal"></div>' +
        '<div class="field"><label>Min performance</label>' +
          '<input type="number" step="any" placeholder="e.g. 2.00" value="' + escAttr(g.min) + '" data-id="' + g.id + '" data-field="min"></div>' +
        '<div class="field"><label>Weight (%)</label>' +
          '<input type="number" min="0" max="100" step="1" placeholder="e.g. 70" value="' + escAttr(g.weight) + '" data-id="' + g.id + '" data-field="weight"></div>' +
        '<div class="field"><label>Lower is better?</label>' +
          '<select data-id="' + g.id + '" data-field="lowerBetter">' +
            '<option value="" disabled' + (g.lowerBetter === undefined || g.lowerBetter === null ? ' selected' : '') + '>Select...</option>' +
            '<option value="true"' + (g.lowerBetter === true ? ' selected' : '') + '>Yes — lower is better (ratio)</option>' +
            '<option value="false"' + (g.lowerBetter === false ? ' selected' : '') + '>No — higher is better (score/rating)</option>' +
          '</select></div>' +
        '<div class="field"><label>Capped?</label>' +
          '<select data-id="' + g.id + '" data-field="capped">' +
            '<option value="" disabled' + (g.capped === null || g.capped === undefined ? ' selected' : '') + '>Select...</option>' +
            '<option value="no"' + (g.capped === 'no' ? ' selected' : '') + '>No</option>' +
            '<option value="yes"' + (g.capped === 'yes' ? ' selected' : '') + '>Yes</option>' +
          '</select></div>' +
        '<div class="field" style="' + (isCapped ? '' : 'visibility:hidden;') + '"><label>Cap at</label>' +
          '<select data-id="' + g.id + '" data-field="capPct">' +
            '<option value="100"' + (g.capPct === '100' ? ' selected' : '') + '>100%</option>' +
            '<option value="120"' + (g.capPct === '120' ? ' selected' : '') + '>120%</option>' +
            '<option value="150"' + (g.capPct === '150' ? ' selected' : '') + '>150%</option>' +
            '<option value="200"' + (g.capPct === '200' ? ' selected' : '') + '>200%</option>' +
          '</select></div>' +
      '</div>';
    c.appendChild(div);
  }
  wireGoalCard(c, updateSetupGoal, removeSetupGoal);
  calcSetupWeights();
}

function calcSetupWeights() {
  var total = 0;
  for (var i = 0; i < setupGoals.length; i++) total += parseFloat(setupGoals[i].weight) || 0;

  if (goalTier === 'individual') {
    // Add dept and company goal weights from preview
    var previewContainer = document.getElementById('setup-preset-container');
    if (previewContainer) {
      var previewItems = previewContainer.querySelectorAll('[data-preset-weight]');
      previewItems.forEach(function(el) { total += parseFloat(el.dataset.presetWeight) || 0; });
    }
    updateWeightBar('setup-weight-bar', 'setup-weight-pct', 'setup-weight-warn', 'setup-weight-total', total, setupGoals.length);
  } else {
    updateWeightBar('setup-weight-bar', 'setup-weight-pct', 'setup-weight-warn', 'setup-weight-total', total, 0);
  }
}

// ── Actuals goals ──────────────────────────────────────────────
function addGoal(name, goalVal, minVal, actual, weight, lowerBetter, isPreset, capped, capPct) {
  var id = nextId++;
  goals.push({
    id: id, name: name || '', goal: goalVal || '', min: minVal || '',
    actual: actual || '', weight: weight || '',
    lowerBetter: (lowerBetter === undefined) ? true : lowerBetter,
    isPreset: isPreset || false,
    capped: capped || 'no', capPct: capPct || 100
  });
  renderGoals();
}

function removeGoal(id) {
  goals = goals.filter(function(g) { return g.id !== id; });
  renderGoals();
}

function updateGoalField(id, field, val) {
  for (var i = 0; i < goals.length; i++) {
    if (goals[i].id === id) { goals[i][field] = val; break; }
  }
  calc();
}

function renderGoals() {
  var c = document.getElementById('goals-container');
  c.innerHTML = '';
  for (var i = 0; i < goals.length; i++) {
    var g = goals[i];
    var div = document.createElement('div');
    div.className = 'goal-card ' + (g.isPreset ? 'prefilled' : 'custom');
    div.innerHTML =
      '<div class="goal-header">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<span style="font-family:var(--mono);font-size:11px;color:var(--text-muted);">Goal ' + (i+1) + '</span>' +
          '<span class="goal-tag ' + (g.isPreset ? 'preset' : 'custom') + '">' + (g.isPreset ? 'preset' : 'custom') + '</span>' +
          (g.capped === 'yes' ? '<span class="goal-tag" style="background:var(--amber-light);color:var(--amber);">Cap: ' + g.capPct + '%</span>' : '') +
          (g.goalTier === 'company' ? '<span class="goal-tag" style="background:#f5e6d3;color:#7a3010;">Company</span>' : g.goalTier === 'department' ? '<span class="goal-tag" style="background:#d6e8d6;color:#1a5c1a;">Department</span>' : '') +
        '</div>' +
        '<button class="remove-goal" data-id="' + g.id + '">&times;</button>' +
      '</div>' +
      '<div class="fields-grid">' +
        '<div class="field half"><label>Goal name</label>' +
          (g.isPreset ? '<input type="text" value="' + escAttr(g.name) + '" disabled style="background:#f0f7e8;color:#5F5E5A;">' : '<input type="text" placeholder="e.g. Individual Ratio" value="' + escAttr(g.name) + '" data-id="' + g.id + '" data-field="name">') + '</div>' +
        '<div class="field"><label>Lower is better?</label>' +
          (g.isPreset ? '<select disabled style="background:#f0f7e8;color:#5F5E5A;"><option>' + (g.lowerBetter ? 'Yes (ratio)' : 'No (score/rating)') + '</option></select>' : '<select data-id="' + g.id + '" data-field="lowerBetter"><option value="true"' + (g.lowerBetter ? ' selected' : '') + '>Yes (ratio)</option><option value="false"' + (!g.lowerBetter ? ' selected' : '') + '>No (score/rating)</option></select>') + '</div>' +
        '<div class="field"><label>Goal target</label>' +
          (g.isPreset ? '<input type="number" value="' + escAttr(g.goal) + '" disabled style="background:#f0f7e8;color:#5F5E5A;">' : '<input type="number" step="any" placeholder="e.g. 2.00" value="' + escAttr(g.goal) + '" data-id="' + g.id + '" data-field="goal">') + '</div>' +
        '<div class="field"><label>Min performance</label>' +
          (g.isPreset ? '<input type="number" value="' + escAttr(g.min) + '" disabled style="background:#f0f7e8;color:#5F5E5A;">' : '<input type="number" step="any" placeholder="e.g. 2.00" value="' + escAttr(g.min) + '" data-id="' + g.id + '" data-field="min">') + '</div>' +
        '<div class="field"><label>Actual result</label>' +
          (g.actualLocked
            ? '<input type="number" step="any" value="' + escAttr(g.actual) + '" disabled style="background:var(--surface2);color:var(--text-muted);cursor:not-allowed;">' +
              '<div style="font-size:10px;color:var(--text-muted);font-family:var(--mono);margin-top:3px;">' +
                (g.hasStoredActual ? '&#10003; ' : '&#9888; ') +
                'Enter in <strong>' + (g.goalTier === "company" ? "Company" : "Department") + ' Actuals</strong> tab' +
              '</div>'
            : '<input type="number" step="any" placeholder="Enter actual" value="' + escAttr(g.actual) + '" data-id="' + g.id + '" data-field="actual"' + (g.hasStoredActual ? ' style="border-color:var(--sage);background:#f0f7ec;"' : '') + '>' +
              (g.hasStoredActual ? '<div style="font-size:10px;color:#6e9464;font-family:var(--mono);margin-top:3px;">&#10003; pre-filled</div>' : '')
          ) +
          '</div>' +
        '<div class="field"><label>Weight (%)</label>' +
          '<input type="number" min="0" max="100" step="1" placeholder="e.g. 70" value="' + escAttr(g.weight) + '" data-id="' + g.id + '" data-field="weight">' + '</div>' +
      '</div>';
    c.appendChild(div);
  }
  wireGoalCard(c, updateGoalField, removeGoal);
  calc();
}

// ── Shared goal card wiring ────────────────────────────────────
function wireGoalCard(container, updateFn, removeFn) {
  var removeBtns = container.querySelectorAll('.remove-goal');
  for (var j = 0; j < removeBtns.length; j++) {
    (function(btn) {
      btn.addEventListener('click', function() { removeFn(parseInt(btn.getAttribute('data-id'))); });
    })(removeBtns[j]);
  }
  var fields = container.querySelectorAll('input[data-id], select[data-id]');
  for (var k = 0; k < fields.length; k++) {
    (function(el) {
      var handler = function() {
        var id = parseInt(el.getAttribute('data-id'));
        var field = el.getAttribute('data-field');
        var val = (field === 'lowerBetter') ? (el.value === 'true') : el.value;
        updateFn(id, field, val);
      };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    })(fields[k]);
  }
}

// ── Fetch roles then goals from Apps Script ───────────────────
function onActualsContextChange() {
  var location = document.getElementById('emp-location').value;
  var dept = document.getElementById('emp-dept').value;
  var periodLabel = getActualsPeriodLabel();

  // Reset role dropdown and goals when context changes
  var roleSelect = document.getElementById('emp-role');
  roleSelect.innerHTML = '<option value="">Loading roles...</option>';
  goals = goals.filter(function(g) { return !g.isPreset; });
  renderGoals();
  document.getElementById('goals-info-banner').style.display = 'none';
  document.getElementById('no-goals-msg').style.display = 'none';
  document.getElementById('goals-loading').style.display = 'none';

  if (!location || !dept || !periodLabel) {
    roleSelect.innerHTML = '<option value="">Select period, location &amp; dept first</option>';
    return;
  }

  // If role is already selected and we're just updating other fields, keep it
  var currentRole = roleSelect.value;

  // Fetch roles from local storage
  apiGetRoles({ location: location, department: dept, month: periodLabel }).then(function(data) {
    if (data && data.roles && data.roles.length > 0) {
      roleSelect.innerHTML = '<option value="">Select a role</option>';
      data.roles.forEach(function(r) {
        var opt = document.createElement('option');
        opt.value = r; opt.textContent = r;
        roleSelect.appendChild(opt);
      });
      if (currentRole) {
        for (var j = 0; j < roleSelect.options.length; j++) {
          if (roleSelect.options[j].value === currentRole) { roleSelect.value = currentRole; break; }
        }
      }
    } else {
      roleSelect.innerHTML = '<option value="">No roles found — check Goal Setup</option>';
    }
  });
}

function fetchTierGoals(location, dept, periodLabel, periodType, callback) {
  Promise.all([
    apiGetGoals({ month: periodLabel, goalTier: 'department', location: location, department: dept }),
    apiGetGoals({ month: periodLabel, goalTier: 'company' })
  ]).then(function(results) {
    var deptGoals = (results[0] && results[0].goals) ? results[0].goals.map(function(g) { g.goalTier='department'; return g; }) : [];
    var companyGoals = (results[1] && results[1].goals) ? results[1].goals.map(function(g) { g.goalTier='company'; return g; }) : [];
    callback(deptGoals, companyGoals);
  });
}


var _roleChangeTimer = null;
function onRoleChange() {
  clearTimeout(_roleChangeTimer);
  _roleChangeTimer = setTimeout(function() { _doRoleChange(); }, 50);
}
function _doRoleChange() {
  var location = document.getElementById('emp-location').value;
  var dept = document.getElementById('emp-dept').value;
  var role = document.getElementById('emp-role').value;
  var periodLabel = getActualsPeriodLabel();
  if (!role) return;

  document.getElementById('goals-loading').style.display = 'block';
  // Fully clear ALL preset goals before fetching new ones
  goals = [];

  Promise.all([
    apiGetGoals({ month: periodLabel, goalTier: 'individual', location: location, department: dept, role: role }),
    apiGetGoals({ month: periodLabel, goalTier: 'department', location: location, department: dept }),
    apiGetGoals({ month: periodLabel, goalTier: 'company' })
  ]).then(function(results) {
    document.getElementById('goals-loading').style.display = 'none';
    var allPreset = [];
    var seenNames = {};
    results.forEach(function(r) {
      if (r && r.goals) r.goals.forEach(function(g) {
        // Deduplicate by name to prevent any double-loading
        if (!seenNames[g.name]) { seenNames[g.name] = true; allPreset.push(g); }
      });
    });
    // Sort by weight descending
    allPreset.sort(function(a, b) { return (parseFloat(b.weight)||0) - (parseFloat(a.weight)||0); });
    if (allPreset.length > 0) {
      document.getElementById('goals-info-banner').textContent = allPreset.length + ' preset goal(s) loaded for ' + role + ' (' + periodLabel + ')';
      document.getElementById('goals-info-banner').style.display = 'block';
      document.getElementById('no-goals-msg').style.display = 'none';
      allPreset.forEach(function(g) {
        var tier = g.goalTier || 'individual';
        var hasStored = g.storedActual !== null && g.storedActual !== undefined;
        // Dept and company actuals are locked — must be entered in their own tabs
        var actualLocked = (tier === 'company' || tier === 'department');
        goals.push({ id: nextId++, name: g.name, goal: g.goalValue, min: g.minValue,
          actual: hasStored ? String(g.storedActual) : '',
          weight: g.weight, lowerBetter: g.lowerBetter !== false, isPreset: true,
          actualLocked: actualLocked,
          capped: g.capped||'no', capPct: g.capPct||100, goalTier: tier,
          hasStoredActual: hasStored });
      });
    } else {
      document.getElementById('no-goals-msg').style.display = 'block';
    }
    renderGoals();
  });
}


function calc() {
  var hourly = parseFloat(document.getElementById('hourly').value) || 0;
  var hours = parseFloat(document.getElementById('hours').value) || 0;
  var bonusPot = parseFloat(document.getElementById('bonusPot').value) || 10;
  var baseEarnings = 0;

  if (payType === 'salary') {
    // Annual salary divided by period
    var annualSalary = hourly; // hourly field repurposed for annual salary
    var isQuarterly = actualsPeriodType === 'quarterly';
    baseEarnings = isQuarterly ? annualSalary / 4 : annualSalary / 12;
    // Auto-fill earnings field
    var earningsEl = document.getElementById('earnings');
    if (earningsEl) {
      earningsEl.value = baseEarnings > 0 ? baseEarnings.toFixed(2) : '';
    }
  } else {
    var earningsInput = document.getElementById('earnings');
    baseEarnings = earningsInput && earningsInput.value !== '' ? parseFloat(earningsInput.value) || 0 : hourly * hours;
  }

  var totalWeight = 0;
  for (var i = 0; i < goals.length; i++) totalWeight += parseFloat(goals[i].weight) || 0;
  updateWeightBar('weight-bar', 'weight-pct', 'weight-warn', 'weight-total', totalWeight, goals.length);

  var totalWeighted = 0;
  var rows = [];
  for (var j = 0; j < goals.length; j++) {
    var g = goals[j];
    var goalVal = parseFloat(g.goal);
    var minVal = parseFloat(g.min);
    var actualVal = parseFloat(g.actual);
    var weightVal = parseFloat(g.weight) || 0;
    if (isNaN(goalVal) || isNaN(minVal) || isNaN(actualVal)) continue;
    var metMin = g.lowerBetter ? (actualVal <= minVal) : (actualVal >= minVal);
    if (!metMin) {
      rows.push({ name: g.name||'Goal', achievement:0, weight:weightVal, weighted:0, bonusContrib:0, met:false, goalValue:goalVal, minValue:minVal, actualValue:actualVal });
      continue;
    }
    var achievement = g.lowerBetter ? (goalVal/actualVal)*100 : (actualVal/goalVal)*100;
    // Apply cap if set
    if (g.capped === 'yes') {
      var cap = parseFloat(g.capPct) || 100;
      if (achievement > cap) achievement = cap;
    }
    var weighted = (achievement/100) * weightVal;
    totalWeighted += weighted;
    var bonusContrib = baseEarnings * (weighted/100) * (bonusPot/100);
    rows.push({ name: g.name||'Goal', achievement:achievement, weight:weightVal, weighted:weighted, bonusContrib:bonusContrib, met:true, goalValue:goalVal, minValue:minVal, actualValue:actualVal });
  }

  // Scorecard-level cap at 200%
  var SCORECARD_CAP = 200;
  var scorecardCapped = totalWeighted > SCORECARD_CAP;
  var cappedWeighted = scorecardCapped ? SCORECARD_CAP : totalWeighted;

  var bonusAmt = baseEarnings * (cappedWeighted/100) * (bonusPot/100);
  var totalPay = baseEarnings + bonusAmt;
  var baseHourlyEarnings = hourly * hours;
  var effectiveHourly = (payType === 'hourly' && hours > 0) ? (baseHourlyEarnings + bonusAmt) / hours : 0;
  var effectiveBonusPct = (cappedWeighted/100) * bonusPot;
  lastResults = { baseEarnings:baseEarnings, totalWeighted:totalWeighted, cappedWeighted:cappedWeighted, scorecardCapped:scorecardCapped, effectiveBonusPct:effectiveBonusPct, bonusAmt:bonusAmt, totalPay:totalPay, effectiveHourly:effectiveHourly, rows:rows, bonusPot:bonusPot };

  var rs = document.getElementById('results-section');
  var bs = document.getElementById('breakdown-section');
  if (rows.length === 0) { rs.style.display='none'; bs.style.display='none'; return; }
  rs.style.display = 'block'; bs.style.display = 'block';

  var achievementLabel = totalWeighted.toFixed(1) + '%' + (scorecardCapped ? ' ⬇ 200% cap' : '');
  var isSalary = (payType === 'salary');
  var metricsHTML =
    '<div class="metric-card"><div class="mlabel">' + (isSalary ? 'Period earnings' : 'Base earnings') + '</div><div class="mval">$' + fmt(baseEarnings) + '</div></div>' +
    '<div class="metric-card"><div class="mlabel">Weighted achievement</div><div class="mval highlight" style="' + (scorecardCapped ? 'font-size:16px;' : '') + '">' + achievementLabel + '</div></div>' +
    '<div class="metric-card"><div class="mlabel">Effective bonus %</div><div class="mval highlight">' + effectiveBonusPct.toFixed(2) + '%</div></div>' +
    '<div class="metric-card"><div class="mlabel">Bonus amount</div><div class="mval highlight">$' + fmt(bonusAmt) + '</div></div>';
  if (!isSalary) {
    metricsHTML +=
      '<div class="metric-card"><div class="mlabel">Total pay this period</div><div class="mval">$' + fmt(totalPay) + '</div></div>' +
      '<div class="metric-card"><div class="mlabel">Effective hourly rate</div><div class="mval highlight">$' + effectiveHourly.toFixed(2) + '/hr</div></div>';
  }
  if (scorecardCapped) {
    metricsHTML += '<div class="metric-card" style="grid-column:1/-1;background:rgba(255,255,255,0.15);border-color:rgba(255,200,0,0.4);"><div class="mlabel" style="color:rgba(255,220,0,0.9);">&#9888; Scorecard cap applied</div><div style="font-size:11px;color:rgba(255,255,255,0.7);">Achievement of ' + totalWeighted.toFixed(1) + '% capped at 200% — bonus calculated on 200%</div></div>';
  }
  document.getElementById('metrics').innerHTML = metricsHTML;

  var tbody = '';
  for (var k = 0; k < rows.length; k++) {
    var r = rows[k];
    tbody += '<tr><td>' + r.name + '</td><td>' + (r.met ? r.achievement.toFixed(1)+'%' : '—') + '</td><td>' + r.weight + '%</td><td>' + (r.met ? r.weighted.toFixed(1)+'%' : '—') + '</td><td>' + (r.met ? '$'+fmt(r.bonusContrib) : '$0.00') + '</td><td><span class="badge ' + (r.met?'met':'unmet') + '">' + (r.met?'Qualified':'No payout') + '</span></td></tr>';
  }
  document.getElementById('breakdown-body').innerHTML = tbody;
}

// ── Weight bar helper ──────────────────────────────────────────
function updateWeightBar(barId, pctId, warnId, totalId, total, count) {
  var bar = document.getElementById(barId);
  var pctLabel = document.getElementById(pctId);
  var warn = document.getElementById(warnId);
  bar.style.width = Math.min(total, 100) + '%';
  var atGoal = Math.abs(total - 100) < 0.01;
  bar.style.background = atGoal ? 'var(--accent-mid)' : total > 100 ? 'var(--red)' : 'var(--amber)';
  pctLabel.textContent = total.toFixed(0) + '%';
  pctLabel.style.color = atGoal ? 'var(--accent)' : 'var(--amber)';
  if (count > 0 && !atGoal) {
    warn.style.display = 'block';
    document.getElementById(totalId).textContent = total.toFixed(0);
  } else {
    warn.style.display = 'none';
  }
}

// ── Submit goal setup ──────────────────────────────────────────
var pendingGoalPayload = null;
var goalTier = 'individual';

function loadSetupPresetGoals() {
  if (goalTier !== 'individual') return;
  var location = document.getElementById('setup-location').value;
  var dept = document.getElementById('setup-dept').value;
  var periodLabel = getSetupPeriodLabel();
  var previewSection = document.getElementById('setup-preset-preview');
  var previewContainer = document.getElementById('setup-preset-container');
  if (!location || !dept || !periodLabel) {
    previewSection.style.display = 'none';
    previewContainer.innerHTML = '';
    return;
  }
  previewContainer.innerHTML = '<div style="font-size:12px;color:var(--text-muted);font-family:var(--mono);padding:8px 0;">Loading...</div>';
  previewSection.style.display = 'block';

  Promise.all([
    apiGetGoals({ month: periodLabel, goalTier: 'department', location: location, department: dept }),
    apiGetGoals({ month: periodLabel, goalTier: 'company' })
  ]).then(function(results) {
    var allPreset = [];
    if (results[0] && results[0].goals) allPreset = allPreset.concat(results[0].goals.map(function(g) { g.goalTier='department'; return g; }));
    if (results[1] && results[1].goals) allPreset = allPreset.concat(results[1].goals.map(function(g) { g.goalTier='company'; return g; }));
    if (allPreset.length === 0) { previewSection.style.display = 'none'; previewContainer.innerHTML = ''; return; }
    allPreset.sort(function(a, b) { return (parseFloat(b.weight)||0) - (parseFloat(a.weight)||0); });
    previewContainer.innerHTML = allPreset.map(function(g) {
      var tierBadge = g.goalTier === 'company'
        ? '<span style="font-size:10px;padding:2px 8px;border-radius:99px;background:#f5e6d3;color:#7a3010;font-family:var(--mono);font-weight:600;">Company</span>'
        : '<span style="font-size:10px;padding:2px 8px;border-radius:99px;background:#d6e8d6;color:#1a5c1a;font-family:var(--mono);font-weight:600;">Department</span>';
      return '<div data-preset-weight="' + (g.weight||0) + '" style="background:var(--surface2);border:1.5px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:8px;opacity:0.85;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
          '<span style="font-size:12px;font-weight:600;color:var(--text);">' + escAttr(g.name) + '</span>' + tierBadge +
          '<span style="margin-left:auto;font-size:12px;font-family:var(--mono);color:var(--text-muted);">' + g.weight + '%</span>' +
        '</div>' +
        '<div style="display:flex;gap:16px;font-size:11px;color:var(--text-muted);font-family:var(--mono);">' +
          '<span>Target: ' + g.goalValue + '</span><span>Min: ' + g.minValue + '</span>' +
          (g.capped === 'yes' ? '<span>Cap: ' + g.capPct + '%</span>' : '') +
        '</div></div>';
    }).join('');
    calcSetupWeights();
  });
}


function setGoalTier(tier) {
  goalTier = tier;
  // Sync dropdown if called programmatically
  var sel = document.getElementById('goal-tier-select');
  if (sel && sel.value !== tier) sel.value = tier || '';

  // Hide context-specific previews when no tier selected
  var setupSubmitSection = document.getElementById('setup-submit-section');
  if (!tier) {
    if (setupSubmitSection) setupSubmitSection.style.display = 'none';
    document.getElementById('saved-individual-goals-preview').style.display = 'none';
    document.getElementById('saved-dept-goals-preview').style.display = 'none';
    document.getElementById('saved-company-goals-preview').style.display = 'none';
    document.getElementById('setup-preset-preview').style.display = 'none';
    document.getElementById('saved-goals-preview').style.display = 'none';
    return;
  }
  if (setupSubmitSection) setupSubmitSection.style.display = '';
  document.querySelectorAll('.setup-individual-field').forEach(function(el) {
    el.style.display = tier === 'individual' ? '' : 'none';
  });
  document.querySelectorAll('.setup-department-field').forEach(function(el) {
    el.style.display = tier === 'department' ? '' : 'none';
  });
  var titles = { individual: 'Scorecard period &amp; role', department: 'Scorecard period &amp; department', company: 'Scorecard period' };
  var goalTitles = { individual: 'Goals for this role', department: 'Goals for this department', company: 'Company-wide goals' };
  var btnLabels = { individual: 'Save Individual Goals', department: 'Save Department Goals', company: 'Save Company Goals' };
  document.getElementById('setup-section-title').innerHTML = titles[tier];
  document.getElementById('setup-goals-title').textContent = goalTitles[tier];
  document.getElementById('setup-submit-btn').textContent = btnLabels[tier];
  setupGoals = [];
  renderSetupGoals();
  var previewSection = document.getElementById('setup-preset-preview');
  if (previewSection) previewSection.style.display = 'none';
  loadSavedGoalsPreview();
}
var payType = 'hourly';

function setPayType(type) {
  payType = type;
  document.getElementById('pay-type-hourly').className = 'period-btn' + (type === 'hourly' ? ' active' : '');
  document.getElementById('pay-type-salary').className = 'period-btn' + (type === 'salary' ? ' active' : '');

  var rateLabel = document.getElementById('pay-rate-label');
  var hoursField = document.getElementById('hours-field');
  var earningsField = document.getElementById('earnings-field');
  var earningsLabel = document.getElementById('earnings-label');
  var earningsInput = document.getElementById('earnings');
  var hourlyInput = document.getElementById('hourly');

  if (type === 'salary') {
    rateLabel.textContent = 'Annual salary ($)';
    hoursField.style.display = 'none';
    earningsLabel.textContent = 'Earnings this period ($)';
    earningsInput.readOnly = true;
    earningsInput.style.background = 'var(--surface2)';
    earningsInput.style.color = 'var(--text-muted)';
    earningsInput.style.cursor = 'not-allowed';
    hourlyInput.placeholder = 'e.g. 65000';
    hourlyInput.value = hourlyInput.value || '';
  } else {
    rateLabel.textContent = 'Hourly rate ($)';
    hoursField.style.display = '';
    earningsLabel.textContent = 'Earnings this period ($)';
    earningsInput.readOnly = false;
    earningsInput.style.background = '';
    earningsInput.style.color = '';
    earningsInput.style.cursor = '';
    hourlyInput.placeholder = 'e.g. 15.00';
  }
  calc();
}
var pendingActualsPayload = null;
var actualsTier = 'individual';
var tierActualsPeriodType = 'monthly';
var companyActualsPeriodType = 'monthly';

function setActualsTier(tier) {
  actualsTier = tier;
  ['individual','department','company'].forEach(function(t) {
    var btn = document.getElementById('actuals-tier-btn-' + t);
    if (btn) {
      btn.style.background = t === tier ? '#fff' : 'none';
      btn.style.color = t === tier ? 'var(--brick)' : 'var(--text-muted)';
    }
    var c = document.getElementById('actuals-' + t + '-content');
    if (c) c.style.display = t === tier ? '' : 'none';
  });
  updateHeaderLabel();
  // Load goals when switching to dept or company tabs
  if (tier === 'company') { loadCompanyActualsGoals(); loadCompanyActualsPreview(); }
  if (tier === 'department') { loadTierActualsGoals(); loadDeptActualsPreview(); }
}

function setTierActualsPeriod(type) {
  tierActualsPeriodType = type;
  document.getElementById('ta-period-monthly').className = 'period-btn' + (type === 'monthly' ? ' active' : '');
  document.getElementById('ta-period-quarterly').className = 'period-btn' + (type === 'quarterly' ? ' active' : '');
  document.getElementById('ta-month-field').style.display = type === 'monthly' ? '' : 'none';
  document.getElementById('ta-quarter-field').style.display = type === 'quarterly' ? '' : 'none';
  document.getElementById('ta-year-field').style.display = type === 'quarterly' ? '' : 'none';
  loadTierActualsGoals();
}

function setCompanyActualsPeriod(type) {
  companyActualsPeriodType = type;
  document.getElementById('ca-period-monthly').className = 'period-btn' + (type === 'monthly' ? ' active' : '');
  document.getElementById('ca-period-quarterly').className = 'period-btn' + (type === 'quarterly' ? ' active' : '');
  document.getElementById('ca-month-field').style.display = type === 'monthly' ? '' : 'none';
  document.getElementById('ca-quarter-field').style.display = type === 'quarterly' ? '' : 'none';
  document.getElementById('ca-year-field').style.display = type === 'quarterly' ? '' : 'none';
  loadCompanyActualsGoals();
}

function getTierActualsPeriodLabel() {
  if (tierActualsPeriodType === 'quarterly') {
    var q = document.getElementById('ta-quarter').value;
    var y = document.getElementById('ta-year').value;
    return (q && y) ? q + ' ' + y : '';
  }
  return formatMonthLabel(document.getElementById('ta-month').value);
}

function getCompanyActualsPeriodLabel() {
  if (companyActualsPeriodType === 'quarterly') {
    var q = document.getElementById('ca-quarter').value;
    var y = document.getElementById('ca-year').value;
    return (q && y) ? q + ' ' + y : '';
  }
  return formatMonthLabel(document.getElementById('ca-month').value);
}

function renderTierActualsGoals(goals, container, tier) {
  if (!goals || goals.length === 0) {
    container.innerHTML = '<div style="font-size:13px;color:var(--text-muted);font-family:var(--mono);">No ' + tier + ' goals found for this combination</div>';
    return;
  }
  container.innerHTML = goals.map(function(g, i) {
    var storedVal = (g.storedActual !== null && g.storedActual !== undefined) ? String(g.storedActual) : '';
    return '<div class="goal-card" style="margin-bottom:10px;">' +
      '<div class="goal-header">' +
        '<span style="font-size:12px;font-weight:600;color:var(--text);">' + escAttr(g.name) + '</span>' +
        '<span style="font-size:11px;font-family:var(--mono);color:var(--text-muted);">' + g.weight + '% weight</span>' +
      '</div>' +
      '<div class="fields-grid">' +
        '<div class="field"><label>Goal target</label><input type="number" value="' + escAttr(String(g.goalValue)) + '" disabled style="background:var(--surface2);color:var(--text-muted);"></div>' +
        '<div class="field"><label>Min performance</label><input type="number" value="' + escAttr(String(g.minValue)) + '" disabled style="background:var(--surface2);color:var(--text-muted);"></div>' +
        '<div class="field"><label>Actual result</label>' +
          '<input type="number" step="any" placeholder="Enter actual" id="ta-actual-' + i + '" class="ta-actual-input"' +
          ' data-goal-name="' + escAttr(g.name) + '" data-goal-value="' + g.goalValue + '" data-min-value="' + g.minValue + '" data-weight="' + g.weight + '"' +
          ' value="' + escAttr(storedVal) + '"' +
          (storedVal ? ' style="border-color:var(--sage);background:#f0f7ec;"' : '') + '>' +
          (storedVal ? '<div style="font-size:10px;color:#6e9464;font-family:var(--mono);margin-top:3px;">&#10003; previously saved</div>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function loadTierActualsGoals() {
  var location = document.getElementById('ta-location').value;
  var dept = document.getElementById('ta-dept').value;
  var periodLabel = getTierActualsPeriodLabel();
  var container = document.getElementById('ta-goals-container');
  if (!location || !dept || !periodLabel) {
    container.innerHTML = '<div style="font-size:13px;color:var(--text-muted);font-family:var(--mono);">Select period, location &amp; department to load goals</div>';
    return;
  }
  container.innerHTML = '<div style="font-size:13px;color:var(--text-muted);font-family:var(--mono);">Loading...</div>';
  apiGetGoals({ month: periodLabel, goalTier: 'department', location: location, department: dept })
    .then(function(data) { renderTierActualsGoals(data && data.goals ? data.goals : [], container, 'dept'); });
}

function loadCompanyActualsGoals() {
  var periodLabel = getCompanyActualsPeriodLabel();
  var container = document.getElementById('ca-goals-container');
  if (!periodLabel) {
    container.innerHTML = '<div style="font-size:13px;color:var(--text-muted);font-family:var(--mono);">Select period to load company goals</div>';
    return;
  }
  container.innerHTML = '<div style="font-size:13px;color:var(--text-muted);font-family:var(--mono);">Loading...</div>';
  apiGetGoals({ month: periodLabel, goalTier: 'company' })
    .then(function(data) {
      var goals = data && data.goals ? data.goals : [];
      if (goals.length === 0) {
        container.innerHTML = '<div style="font-size:13px;color:var(--text-muted);font-family:var(--mono);">No company goals found for ' + periodLabel + ' — set them up in Goal Setup first</div>';
      } else {
        renderTierActualsGoals(goals, container, 'company');
      }
    })
    .catch(function(e) {
      container.innerHTML = '<div style="font-size:13px;color:var(--red);">Error loading goals: ' + e.message + '</div>';
    });
}


async function updateScorecardsWithTierActuals(tier, location, dept, month, results) {
  // Also fetch the full goal definitions so we can add missing goals to scorecards
  var goalDefs = await storageGetGoals(month);
  var scorecards = await storageGetScorecards(month);
  var updated = false;

  scorecards.forEach(function(sc) {
    var matches = tier === 'company' ? true :
                  (tier === 'department' && sc.location === location && sc.department === dept);
    if (!matches) return;

    results.forEach(function(result) {
      if (result.actual === '' || result.actual === null || result.actual === undefined) return;
      var actualVal = parseFloat(result.actual);
      if (isNaN(actualVal)) return;

      // Check if goal already exists in scorecard
      var existing = null;
      if (sc.goals) sc.goals.forEach(function(g) { if (g.name === result.name) existing = g; });

      if (existing) {
        // Update existing goal
        existing.actualValue = actualVal;
      } else {
        // Goal not in scorecard yet — find definition and add it
        var def = null;
        goalDefs.forEach(function(gd) {
          if (gd.name === result.name && (gd.goalTier || inferTier(gd)) === tier) def = gd;
        });
        if (def) {
          if (!sc.goals) sc.goals = [];
          existing = {
            name: def.name, weight: def.weight, goalValue: def.goalValue, minValue: def.minValue,
            capped: def.capped || 'no', capPct: def.capPct || 100, lowerBetter: def.lowerBetter !== false,
            goalTier: tier, actualValue: actualVal, achievement: 0, weightedAchievement: 0,
            bonusContribution: 0, qualified: false
          };
          sc.goals.push(existing);
        }
      }

      if (existing) {
        // Recalculate achievement for this goal
        var goalVal = parseFloat(existing.goalValue);
        var lowerBetter = existing.lowerBetter !== false;
        if (goalVal && actualVal) {
          existing.achievement = lowerBetter ? (goalVal / actualVal) * 100 : (actualVal / goalVal) * 100;
          if (existing.capped === 'yes' && existing.achievement > (existing.capPct || 100)) {
            existing.achievement = existing.capPct || 100;
          }
        }
        existing.qualified = lowerBetter ? actualVal <= parseFloat(existing.minValue) : actualVal >= parseFloat(existing.minValue);
        updated = true;
      }
    });

    if (updated && sc.goals) {
      // Recalculate scorecard totals
      var totalWeighted = 0;
      sc.goals.forEach(function(g) {
        var weighted = ((g.achievement || 0) / 100) * (parseFloat(g.weight) || 0);
        g.weightedAchievement = weighted;
        g.bonusContribution = parseFloat(sc.baseEarnings || 0) * (weighted / 100) * ((parseFloat(sc.bonusPotentialPct) || 10) / 100);
        totalWeighted += weighted;
      });
      var SCORECARD_CAP = 200;
      sc.scorecardCapped = totalWeighted > SCORECARD_CAP;
      sc.weightedAchievement = sc.scorecardCapped ? SCORECARD_CAP : totalWeighted;
      var baseEarnings = parseFloat(sc.baseEarnings) || 0;
      var bonusPot = parseFloat(sc.bonusPotentialPct) || 10;
      sc.bonusAmount = parseFloat((baseEarnings * (sc.weightedAchievement / 100) * (bonusPot / 100)).toFixed(2));
    }
  });

  if (updated) {
    await storageSetScorecards(month, scorecards);
    loadSubmittedScorecardsPreview();
    showToast('Scorecards updated with new actuals!', 'success');
  }
}

function renderSavedActualsPreview(goals, sectionId, listId, titleId, titleText) {
  var section = document.getElementById(sectionId);
  var list = document.getElementById(listId);
  var title = document.getElementById(titleId);
  if (!section || !list) return;

  var withActuals = goals.filter(function(g) {
    return g.storedActual !== null && g.storedActual !== undefined && g.storedActual !== '';
  });

  if (withActuals.length === 0) { section.style.display = 'none'; return; }

  section.style.display = 'block';
  title.textContent = titleText + ' (' + withActuals.length + ' goal' + (withActuals.length !== 1 ? 's' : '') + ')';

  list.innerHTML = withActuals.map(function(g) {
    var actual = parseFloat(g.storedActual);
    var goalVal = parseFloat(g.goalValue);
    var lowerBetter = g.lowerBetter !== false;
    var achievement = (goalVal && actual) ? (lowerBetter ? (goalVal/actual)*100 : (actual/goalVal)*100) : 0;
    var achievementColor = achievement >= 100 ? '#2D6B1A' : '#703c2e';
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">' +
      '<div>' +
        '<div style="font-size:13px;font-weight:600;color:var(--text);">' + escAttr(g.name) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);font-family:var(--mono);margin-top:2px;">' +
          'Target: ' + g.goalValue + ' &nbsp;|&nbsp; Actual: ' + g.storedActual + ' &nbsp;|&nbsp; Weight: ' + g.weight + '%' +
        '</div>' +
      '</div>' +
      '<span style="font-size:14px;font-weight:700;font-family:var(--mono);color:' + achievementColor + ';white-space:nowrap;margin-left:12px;">' +
        achievement.toFixed(1) + '%' +
      '</span>' +
    '</div>';
  }).join('') +
  '<div style="font-size:11px;color:var(--text-muted);font-family:var(--mono);padding-top:8px;">' +
    withActuals.length + ' of ' + goals.length + ' goals have actuals entered' +
  '</div>';
}

async function loadDeptActualsPreview() {
  var location = document.getElementById('ta-location').value;
  var dept = document.getElementById('ta-dept').value;
  var periodLabel = getTierActualsPeriodLabel();
  if (!location || !dept || !periodLabel) { document.getElementById('saved-dept-actuals-section').style.display = 'none'; return; }
  var data = await apiGetGoals({ month: periodLabel, goalTier: 'department', location: location, department: dept });
  var goals = data && data.goals ? data.goals : [];
  renderSavedActualsPreview(goals, 'saved-dept-actuals-section', 'saved-dept-actuals-list', 'saved-dept-actuals-title',
    'Saved — ' + dept + ' (' + location + ') — ' + periodLabel);
}

async function loadCompanyActualsPreview() {
  var periodLabel = getCompanyActualsPeriodLabel();
  if (!periodLabel) { document.getElementById('saved-company-actuals-section').style.display = 'none'; return; }
  var data = await apiGetGoals({ month: periodLabel, goalTier: 'company' });
  var goals = data && data.goals ? data.goals : [];
  renderSavedActualsPreview(goals, 'saved-company-actuals-section', 'saved-company-actuals-list', 'saved-company-actuals-title',
    'Saved — Company — ' + periodLabel);
}

function submitTierActuals() {
  var location = document.getElementById('ta-location').value;
  var dept = document.getElementById('ta-dept').value;
  var periodLabel = getTierActualsPeriodLabel();
  if (!location || !dept || !periodLabel) { showToast('Please fill in all fields', 'error'); return; }
  var inputs = document.querySelectorAll('.ta-actual-input');
  var results = [], allFilled = true;
  inputs.forEach(function(inp) {
    if (inp.value === '') allFilled = false;
    results.push({ name: inp.dataset.goalName, actual: inp.value });
  });
  if (!allFilled) { showToast('Please enter all actual results', 'error'); return; }
  var btn = document.getElementById('ta-submit-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  apiSaveTierActuals({ goalTier: 'department', location: location, department: dept, scorecardMonth: periodLabel, results: results })
    .then(function() {
      btn.disabled = false; btn.textContent = 'Save Department Actuals';
      showToast('Department actuals saved!', 'success');
      updateScorecardsWithTierActuals('department', location, dept, periodLabel, results);
      loadDeptActualsPreview();
    })
    .catch(function() { btn.disabled = false; btn.textContent = 'Save Department Actuals'; showToast('Save failed', 'error'); });
}

function submitCompanyActuals() {
  var periodLabel = getCompanyActualsPeriodLabel();
  if (!periodLabel) { showToast('Please select a period', 'error'); return; }
  var inputs = document.querySelectorAll('#ca-goals-container .ta-actual-input');
  var results = [], allFilled = true;
  inputs.forEach(function(inp) {
    if (inp.value === '') allFilled = false;
    results.push({ name: inp.dataset.goalName, actual: inp.value });
  });
  if (!allFilled) { showToast('Please enter all actual results', 'error'); return; }
  var btn = document.getElementById('ca-submit-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  apiSaveTierActuals({ goalTier: 'company', scorecardMonth: periodLabel, results: results })
    .then(function() {
      btn.disabled = false; btn.textContent = 'Save Company Actuals';
      showToast('Company actuals saved!', 'success');
      updateScorecardsWithTierActuals('company', '', '', periodLabel, results);
      loadCompanyActualsPreview();
    })
    .catch(function() { btn.disabled = false; btn.textContent = 'Save Company Actuals'; showToast('Save failed', 'error'); });
}
var setupPeriodType = 'monthly';
var actualsPeriodType = 'monthly';

function setSetupPeriod(type) {
  setupPeriodType = type;
  document.getElementById('setup-period-monthly').className = 'period-btn' + (type === 'monthly' ? ' active' : '');
  document.getElementById('setup-period-quarterly').className = 'period-btn' + (type === 'quarterly' ? ' active' : '');
  document.getElementById('setup-month-field').style.display = type === 'monthly' ? '' : 'none';
  document.getElementById('setup-quarter-field').style.display = type === 'quarterly' ? '' : 'none';
  document.getElementById('setup-year-field').style.display = type === 'quarterly' ? '' : 'none';
  updateHeaderLabel();
  loadSavedGoalsPreview();
  loadSetupTierGoalPreviews();
  loadSetupPeriodOverview();
}

function setActualsPeriod(type) {
  actualsPeriodType = type;
  document.getElementById('actuals-period-monthly').className = 'period-btn' + (type === 'monthly' ? ' active' : '');
  document.getElementById('actuals-period-quarterly').className = 'period-btn' + (type === 'quarterly' ? ' active' : '');
  document.getElementById('actuals-month-field').style.display = type === 'monthly' ? '' : 'none';
  document.getElementById('actuals-quarter-field').style.display = type === 'quarterly' ? '' : 'none';
  document.getElementById('actuals-year-field').style.display = type === 'quarterly' ? '' : 'none';
  updateHeaderLabel();
  // Reset role dropdown and goals
  goals = goals.filter(function(g) { return !g.isPreset; });
  renderGoals();
  document.getElementById('emp-role').innerHTML = '<option value="">Select period, location &amp; dept first</option>';
  document.getElementById('goals-info-banner').style.display = 'none';
  document.getElementById('no-goals-msg').style.display = 'none';
}

function formatMonthLabel(m) {
  if (!m || typeof m !== 'string') return '';
  var parts = m.split('-');
  if (parts.length < 2) return m;
  var year = parseInt(parts[0]);
  var month = parseInt(parts[1]) - 1;
  if (isNaN(year) || isNaN(month)) return m;
  var d = new Date(year, month, 1);
  return d.toLocaleString('default', { month: 'long', year: 'numeric' });
}

function getSetupPeriodLabel() {
  if (setupPeriodType === 'quarterly') {
    var q = document.getElementById('setup-quarter').value;
    var y = document.getElementById('setup-year').value;
    return q && y ? q + ' ' + y : '';
  }
  var m = document.getElementById('setup-month').value;
  return m ? formatMonthLabel(m) : '';
}

function getActualsPeriodLabel() {
  // act2 period (new actuals tab)
  if (document.getElementById('act2-month')) return act2GetPeriodLabel ? act2GetPeriodLabel() : '';
  // old actuals fallback
  if (actualsPeriodType === 'quarterly') {
    var q = document.getElementById('emp-quarter'); var y = document.getElementById('emp-year');
    return (q&&y&&q.value&&y.value) ? q.value+' '+y.value : '';
  }
  var m = document.getElementById('emp-month');
  return m && m.value ? formatMonthLabel(m.value) : '';
}

function submitGoalSetup() {
  var location = goalTier === 'individual' ? document.getElementById('setup-location').value :
                 goalTier === 'department' ? document.getElementById('setup-dept-location').value : '';
  var dept = goalTier === 'individual' ? document.getElementById('setup-dept').value :
             goalTier === 'department' ? document.getElementById('setup-dept-only').value : '';
  var role = goalTier === 'individual' ? document.getElementById('setup-role').value : '';
  var bonusPot = document.getElementById('setup-bonus-pot').value;
  var periodLabel = getSetupPeriodLabel();

  if (!periodLabel) {
    showToast(setupPeriodType === 'quarterly' ? 'Please select a quarter and year' : 'Scorecard month is required', 'error');
    return;
  }

  // Block goal setup for periods more than 2 months in the past
  if (setupPeriodType === 'monthly') {
    var setupMonth = document.getElementById('setup-month').value;
    if (setupMonth) {
      var now = new Date();
      var selected = new Date(setupMonth + '-01');
      var twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      if (selected < twoMonthsAgo) {
        showToast('Goals for ' + periodLabel + ' are locked — cannot modify goals more than 2 months in the past', 'error');
        return;
      }
    }
  } else if (setupPeriodType === 'quarterly') {
    var qVal = document.getElementById('setup-quarter').value;
    var yVal = parseInt(document.getElementById('setup-year').value);
    if (qVal && yVal) {
      var now2 = new Date();
      var currentQ = Math.floor(now2.getMonth() / 3) + 1;
      var currentY = now2.getFullYear();
      var selQ = parseInt(qVal.replace('Q', ''));
      var currentQNum = currentY * 4 + currentQ;
      var selQNum = yVal * 4 + selQ;
      if (selQNum < currentQNum - 2) {
        showToast('Goals for ' + periodLabel + ' are locked — cannot modify goals more than 2 quarters in the past', 'error');
        return;
      }
    }
  }
  if (goalTier === 'individual') {
    if (!location) { showToast('Location is required', 'error'); return; }
    if (!dept)     { showToast('Department is required', 'error'); return; }
    if (!role)     { showToast('Role / title is required', 'error'); return; }
  } else if (goalTier === 'department') {
    if (!location) { showToast('Location is required', 'error'); return; }
    if (!dept)     { showToast('Department is required', 'error'); return; }
  }
  if (setupGoals.length === 0) { showToast('Please add at least one goal', 'error'); return; }

  // Check total weight including dept/company presets
  if (goalTier === 'individual') {
    var totalW = 0;
    for (var wi = 0; wi < setupGoals.length; wi++) totalW += parseFloat(setupGoals[wi].weight) || 0;
    var previewItems = document.querySelectorAll('#setup-preset-container [data-preset-weight]');
    previewItems.forEach(function(el) { totalW += parseFloat(el.dataset.presetWeight) || 0; });
    if (Math.abs(totalW - 100) > 0.01) {
      showToast('Total weights (including dept & company goals) must equal 100% — currently ' + totalW.toFixed(0) + '%', 'error');
      return;
    }
  }


  for (var i = 0; i < setupGoals.length; i++) {
    var g = setupGoals[i];
    if (!g.name)     { showToast('Goal ' + (i+1) + ' needs a name', 'error'); return; }
    if (g.goal === '') { showToast('Goal ' + (i+1) + ' needs a goal target', 'error'); return; }
    if (g.min === '')  { showToast('Goal ' + (i+1) + ' needs a minimum performance value', 'error'); return; }
    if (g.weight === '') { showToast('Goal ' + (i+1) + ' needs a weight', 'error'); return; }
    if (g.lowerBetter === null || g.lowerBetter === undefined || g.lowerBetter === '') { showToast('Goal ' + (i+1) + ': please select if lower is better', 'error'); return; }
    if (g.capped === null || g.capped === undefined || g.capped === '') { showToast('Goal ' + (i+1) + ': please select if the goal is capped', 'error'); return; }
  }
  pendingGoalPayload = {
    action: 'saveGoals',
    scorecardMonth: periodLabel,
    periodType: setupPeriodType,
    goalTier: goalTier,
    location: location,
    department: dept,
    role: role,
    bonusPot: parseFloat(bonusPot),
    goals: setupGoals.map(function(g) {
      return { name: g.name, goalValue: parseFloat(g.goal), minValue: parseFloat(g.min), weight: parseFloat(g.weight), lowerBetter: g.lowerBetter !== false, capped: g.capped || 'no', capPct: parseInt(g.capPct) || 100 };
    })
  };

  // Check if goals already exist for this role/location/dept/month
  checkExistingGoals(location, dept, role, periodLabel, setupPeriodType, goalTier, function(exists) {
    if (exists) {
      // Show warning modal
      document.getElementById('overwrite-msg').textContent =
        'Goal information for this role already exists for the month you selected. Do you want to update the existing goal information?';
      var modal = document.getElementById('overwrite-modal');
      modal.style.display = 'flex';
    } else {
      doSaveGoals();
    }
  });
}

function checkExistingGoals(location, dept, role, month, periodType, tier, callback) {
  apiCheckGoals({ location: location, department: dept, role: role, month: month, goalTier: tier })
    .then(function(data) {
      callback(data && data.exists);
    })
    .catch(function(e) {
      callback(false); // assume no existing goals on error
    });
}


function doSaveGoals() {
  if (!pendingGoalPayload) return;
  var btn = document.getElementById('setup-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  var tierLabel = goalTier === 'company' ? 'Save Company Goals' : goalTier === 'department' ? 'Save Department Goals' : 'Save Individual Goals';
  apiSaveGoals(pendingGoalPayload).then(function() {
    btn.disabled = false;
    btn.textContent = tierLabel;
    pendingGoalPayload = null;
    showToast('Goals saved!', 'success');
    setupGoals = [];
    renderSetupGoals();
    loadSavedGoalsPreview();
  }).catch(function(e) {
    btn.disabled = false;
    btn.textContent = tierLabel;
    showToast('Save failed: ' + e.message, 'error');
  });
}

// ── Submit actuals ─────────────────────────────────────────────
function submitToSheet() {
  var empName    = document.getElementById('emp-name').value.trim();
  var empRole    = document.getElementById('emp-role').value.trim();
  var empDept    = document.getElementById('emp-dept').value;
  var empLocation= document.getElementById('emp-location').value;
  var empManager = document.getElementById('emp-manager').value.trim();
  var periodLabel = getActualsPeriodLabel();

  if (!empName)     { showToast('Employee name is required', 'error'); return; }
  if (!empRole)     { showToast('Role / title is required', 'error'); return; }
  if (!empDept)     { showToast('Department is required', 'error'); return; }
  if (!empLocation) { showToast('Location is required', 'error'); return; }
  if (!empManager)  { showToast('Manager name is required', 'error'); return; }
  if (payType === 'hourly') {
    var earningsVal = document.getElementById('earnings').value;
    if (!earningsVal || parseFloat(earningsVal) <= 0) { showToast('Earnings this period is required', 'error'); return; }
  } else {
    var annualVal = document.getElementById('hourly').value;
    if (!annualVal || parseFloat(annualVal) <= 0) { showToast('Annual salary is required', 'error'); return; }
  }
  if (!periodLabel) { showToast(actualsPeriodType === 'quarterly' ? 'Please select a quarter and year' : 'Scorecard month is required', 'error'); return; }

  // Validate period is not in the future or more than 2 months prior
  if (actualsPeriodType === 'monthly') {
    var selectedMonth = document.getElementById('emp-month').value;
    if (selectedMonth) {
      var now = new Date();
      var selected = new Date(selectedMonth + '-01');
      var currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      var twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      if (selected > currentMonth) {
        showToast('Cannot enter actuals for a future month', 'error'); return;
      }
      if (selected < twoMonthsAgo) {
        showToast('Cannot enter actuals more than 2 months in the past', 'error'); return;
      }
    }
  } else if (actualsPeriodType === 'quarterly') {
    var qVal = document.getElementById('emp-quarter').value;
    var yVal = parseInt(document.getElementById('emp-year').value);
    if (qVal && yVal) {
      var now2 = new Date();
      var currentQ = Math.floor(now2.getMonth() / 3) + 1;
      var currentY = now2.getFullYear();
      var selQ = parseInt(qVal.replace('Q', ''));
      // Convert to comparable number: year * 4 + quarter
      var currentQNum = currentY * 4 + currentQ;
      var selQNum = yVal * 4 + selQ;
      if (selQNum > currentQNum) {
        showToast('Cannot enter actuals for a future quarter', 'error'); return;
      }
      if (selQNum < currentQNum - 2) {
        showToast('Cannot enter actuals more than 2 quarters in the past', 'error'); return;
      }
    }
  }
  if (!lastResults || lastResults.rows.length === 0) { showToast('Please enter actual results for at least one goal', 'error'); return; }

  var totalGW = 0;
  for (var gi0 = 0; gi0 < goals.length; gi0++) totalGW += parseFloat(goals[gi0].weight) || 0;
  if (Math.abs(totalGW - 100) > 0.01) { showToast('Goal weights must total 100% — currently ' + totalGW.toFixed(0) + '%', 'error'); return; }

  for (var gi = 0; gi < goals.length; gi++) {
    var g = goals[gi];
    if (!g.name)     { showToast('Goal ' + (gi+1) + ' needs a name', 'error'); return; }
    if (g.goal === '') { showToast('Goal ' + (gi+1) + ' needs a goal target', 'error'); return; }
    if (g.min === '')  { showToast('Goal ' + (gi+1) + ' needs a min performance value', 'error'); return; }
    if (!g.actualLocked && g.actual === '') { showToast('Goal ' + (gi+1) + ' (' + g.name + ') needs an actual result', 'error'); return; }
    // Dept/company actuals can be empty — they'll be filled in later
    if (g.weight === '') { showToast('Goal ' + (gi+1) + ' needs a weight', 'error'); return; }
  }

  var payload = {
    action: 'submitActuals',
    submittedAt: new Date().toISOString(),
    scorecardMonth: periodLabel,
    periodType: actualsPeriodType,
    employeeName: empName,
    role: empRole,
    department: empDept,
    location: empLocation,
    manager: empManager,
    payType: payType,
    hourlyRate: parseFloat(document.getElementById('hourly').value),
    earningsThisPeriod: parseFloat(document.getElementById('earnings').value) || 0,
    hoursWorked: parseFloat(document.getElementById('hours').value),
    bonusPotentialPct: parseFloat(document.getElementById('bonusPot').value),
    baseEarnings: lastResults.baseEarnings,
    weightedAchievement: parseFloat(lastResults.totalWeighted.toFixed(2)),
    cappedWeightedAchievement: parseFloat(lastResults.cappedWeighted.toFixed(2)),
    scorecardCapped: lastResults.scorecardCapped,
    effectiveBonusPct: parseFloat(lastResults.effectiveBonusPct.toFixed(2)),
    bonusAmount: parseFloat(lastResults.bonusAmt.toFixed(2)),
    totalMonthlyPay: parseFloat(lastResults.totalPay.toFixed(2)),
    effectiveHourlyRate: parseFloat(lastResults.effectiveHourly.toFixed(2)),
    goals: lastResults.rows.map(function(r) {
      return {
        name: r.name, weight: r.weight,
        goalValue: parseFloat(r.goalValue),
        minValue: parseFloat(r.minValue),
        actualValue: parseFloat(r.actualValue),
        achievement: parseFloat(r.achievement.toFixed(2)),
        weightedAchievement: parseFloat(r.weighted.toFixed(2)),
        bonusContribution: parseFloat(r.bonusContrib.toFixed(2)),
        qualified: r.met
      };
    })
  };

  // Check if actuals already exist for this employee/period before submitting
  pendingActualsPayload = payload;
  checkExistingActuals(empName, periodLabel, actualsPeriodType, function(exists) {
    if (exists) {
      document.getElementById('duplicate-msg').textContent =
        'Actuals for ' + empName + ' in ' + periodLabel + ' have already been submitted. ' +
        'Updating will replace their existing scorecard.';
      var modal = document.getElementById('duplicate-modal');
      modal.style.display = 'flex';
    } else {
      doSubmitActuals();
    }
  });
}

function checkExistingActuals(empName, period, periodType, callback) {
  apiCheckActuals({ employeeName: empName, period: period })
    .then(function(data) { callback(data && data.exists); });
}


function doSubmitActuals() {
  if (!pendingActualsPayload) return;
  var payload = pendingActualsPayload;
  var btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  sendToScript(payload, function(success) {
    btn.disabled = false;
    btn.textContent = 'Submit to Google Sheet';
    pendingActualsPayload = null;
    if (success) {
      showToast('Submitted successfully!', 'success');
      loadSubmittedScorecardsPreview();
    } else {
      showToast('Submission failed — check connection', 'error');
    }
  });
}

// ── Local API dispatcher (replaces iframe POST) ────────────────
function sendToScript(payload, callback) {
  var action = payload.action || '';
  var promise;
  if (action === 'saveGoals') {
    promise = apiSaveGoals(payload);
  } else if (action === 'saveTierActuals') {
    promise = apiSaveTierActuals(payload);
  } else {
    promise = apiSaveScorecard(payload);
  }
  promise.then(function(result) {
    callback(result && result.status !== 'error');
  }).catch(function() { callback(false); });
}



function renderSavedGoalsSection(goals, sectionId, listId, titleId, titleText) {
  var section = document.getElementById(sectionId);
  var list = document.getElementById(listId);
  var title = document.getElementById(titleId);
  if (!section || !list) return;
  if (!goals || goals.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  title.textContent = titleText + ' (' + goals.length + ' goal' + (goals.length !== 1 ? 's' : '') + ')';
  var totalWeight = goals.reduce(function(s, g) { return s + (parseFloat(g.weight)||0); }, 0);
  list.innerHTML = goals.map(function(g) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">' +
      '<div>' +
        '<div style="font-size:13px;font-weight:600;color:var(--text);">' + escAttr(g.name) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);font-family:var(--mono);margin-top:2px;">' +
          'Target: ' + g.goalValue + ' &nbsp;|&nbsp; Min: ' + g.minValue +
          (g.capped === 'yes' ? ' &nbsp;|&nbsp; Cap: ' + g.capPct + '%' : '') +
          ' &nbsp;|&nbsp; Lower is better: ' + (g.lowerBetter !== false ? 'Yes' : 'No') +
        '</div>' +
      '</div>' +
      '<span style="font-size:14px;font-weight:700;color:var(--brick);font-family:var(--mono);white-space:nowrap;margin-left:12px;">' + g.weight + '%</span>' +
    '</div>';
  }).join('') +
  '<div style="display:flex;justify-content:space-between;padding:8px 0 0;font-size:11px;font-family:var(--mono);">' +
    '<span style="color:var(--text-muted);">' + goals.length + ' goal' + (goals.length !== 1 ? 's' : '') + '</span>' +
    '<span style="font-weight:700;color:var(--text);">Total weight: ' + totalWeight.toFixed(0) + '%</span>' +
  '</div>';
}

async function loadSetupTierGoalPreviews() {
  var periodLabel = getSetupPeriodLabel();
  if (!periodLabel) {
    document.getElementById('saved-dept-goals-preview').style.display = 'none';
    document.getElementById('saved-company-goals-preview').style.display = 'none';
    return;
  }

  // Individual goals — only on individual tier, only when location+dept+role all selected
  if (goalTier === 'individual') {
    var indLocation = document.getElementById('setup-location').value;
    var indDept = document.getElementById('setup-dept').value;
    var indRole = document.getElementById('setup-role').value;
    if (indLocation && indDept && indRole) {
      var indData = await apiGetGoals({ month: periodLabel, goalTier: 'individual', location: indLocation, department: indDept, role: indRole });
      renderSavedGoalsSection(indData.goals || [], 'saved-individual-goals-preview', 'saved-individual-goals-list', 'saved-individual-goals-title',
        indRole + ' — ' + indDept + ' (' + indLocation + ') — ' + periodLabel);
    } else {
      document.getElementById('saved-individual-goals-preview').style.display = 'none';
    }
  } else {
    document.getElementById('saved-individual-goals-preview').style.display = 'none';
  }

  // Company goals — only on company tier
  if (goalTier === 'company') {
    var compData = await apiGetGoals({ month: periodLabel, goalTier: 'company' });
    renderSavedGoalsSection(compData.goals || [], 'saved-company-goals-preview', 'saved-company-goals-list', 'saved-company-goals-title',
      'Company goals — ' + periodLabel);
  } else {
    document.getElementById('saved-company-goals-preview').style.display = 'none';
  }

  // Dept goals — only on department tier, only when location+dept both selected
  if (goalTier === 'department') {
    var deptLocation = document.getElementById('setup-dept-location') ? document.getElementById('setup-dept-location').value : '';
    var deptDept = document.getElementById('setup-dept-only') ? document.getElementById('setup-dept-only').value : '';
    if (deptLocation && deptDept) {
      var deptData = await apiGetGoals({ month: periodLabel, goalTier: 'department', location: deptLocation, department: deptDept });
      renderSavedGoalsSection(deptData.goals || [], 'saved-dept-goals-preview', 'saved-dept-goals-list', 'saved-dept-goals-title',
        'Department goals — ' + deptDept + ' (' + deptLocation + ') — ' + periodLabel);
    } else {
      document.getElementById('saved-dept-goals-preview').style.display = 'none';
    }
  } else {
    document.getElementById('saved-dept-goals-preview').style.display = 'none';
  }

  // Individual goals — show when location, dept and role are all selected
  var indLocation = document.getElementById('setup-location').value;
  var indDept = document.getElementById('setup-dept').value;
  var indRole = document.getElementById('setup-role') ? document.getElementById('setup-role').value : '';
  var indSection = document.getElementById('saved-individual-goals-preview');
  if (goalTier === 'individual' && indLocation && indDept && indRole) {
    var indData = await apiGetGoals({ month: periodLabel, goalTier: 'individual', location: indLocation, department: indDept, role: indRole });
    renderSavedGoalsSection(indData.goals || [], 'saved-individual-goals-preview', 'saved-individual-goals-list', 'saved-individual-goals-title',
      'Individual goals — ' + indRole + ' (' + indDept + ', ' + indLocation + ') — ' + periodLabel);
  } else if (indSection) {
    indSection.style.display = 'none';
  }
}

async function loadSetupPeriodOverview() {
  var periodLabel = getSetupPeriodLabel();
  var section = document.getElementById('setup-period-overview');
  if (!section) return;
  if (!periodLabel) { section.style.display = 'none'; return; }

  // Sync the Goals Overview tab's period to match, then use its proven storage logic
  var overviewMonthEl = document.getElementById('overview-month');
  if (overviewMonthEl) {
    // Convert period label back to YYYY-MM for the month input
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var parts = periodLabel.split(' ');
    var mIdx = months.indexOf(parts[0]);
    var yr = parseInt(parts[1]);
    if (mIdx >= 0 && yr) {
      overviewMonthEl.value = yr + '-' + String(mIdx+1).padStart(2,'0');
      overviewPeriodType = 'monthly';
    }
  }

  // Run loadOverview to populate _overviewGoals
  await loadOverview();

  // Store goals and render with filter function
  var title = document.getElementById('setup-period-overview-title');
  if (!_overviewGoals || _overviewGoals.length === 0) {
    section.style.display = 'none';
    return;
  }

  _setupOverviewGoals = _overviewGoals.slice();
  section.style.display = 'block';
  title.textContent = 'All goals this period — ' + periodLabel + ' (' + _setupOverviewGoals.length + ')';

  // Build thead
  var colCtx  = 'background:#faf8f5;';
  var colGoal = 'background:#f2f7fa;';
  var colRes  = 'background:#f5f8f3;';
  var th = function(label, bg) {
    return '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;color:var(--text-muted);' + bg + 'border-bottom:2px solid var(--border);white-space:nowrap;">' + label + '</th>';
  };
  document.getElementById('setup-overview-thead').innerHTML =
    '<tr>' + th('Type',colCtx) + th('Department',colCtx) + th('Role',colCtx) +
    th('Goal Name',colGoal) + th('Weight',colGoal) + th('Target',colGoal) + th('Min',colGoal) +
    th('Actual',colRes) + th('Achievement',colRes) + '</tr>';

  filterSetupOverview();
}


var _setupOverviewGoals = [];

function filterSetupOverview(reset) {
  if (reset) {
    document.getElementById('spo-filter-tier').value = '';
    document.getElementById('spo-filter-dept').value = '';
    document.getElementById('spo-sort').value = 'tier';
  }
  var tierFilter = document.getElementById('spo-filter-tier').value;
  var deptFilter = document.getElementById('spo-filter-dept').value;
  var sortBy = document.getElementById('spo-sort').value;

  var filtered = _setupOverviewGoals.filter(function(g) {
    var tier = g.goalTier || inferTier(g);
    if (tierFilter && tier !== tierFilter) return false;
    if (deptFilter && g.department !== deptFilter) return false;
    return true;
  });

  filtered.sort(function(a, b) {
    var tierOrder = { company: 0, department: 1, individual: 2 };
    if (sortBy === 'tier') {
      var ta = tierOrder[a.goalTier||inferTier(a)]||0, tb = tierOrder[b.goalTier||inferTier(b)]||0;
      if (ta !== tb) return ta - tb;
      return (a.department||'') < (b.department||'') ? -1 : 1;
    }
    if (sortBy === 'dept') return (a.department||'') < (b.department||'') ? -1 : 1;
    if (sortBy === 'role') return (a.role||'') < (b.role||'') ? -1 : 1;
    if (sortBy === 'name') return (a.name||'') < (b.name||'') ? -1 : 1;
    if (sortBy === 'weight-desc') return (parseFloat(b.weight)||0) - (parseFloat(a.weight)||0);
    if (sortBy === 'weight-asc') return (parseFloat(a.weight)||0) - (parseFloat(b.weight)||0);
    return 0;
  });

  var tbody = document.getElementById('setup-overview-tbody');
  var empty = document.getElementById('spo-empty');
  if (!tbody) return;

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  var colCtx  = 'background:#faf8f5;';
  var colGoal = 'background:#f2f7fa;';
  var colRes  = 'background:#f5f8f3;';
  var border  = 'border-bottom:1px solid var(--border);';
  var tierColors = { company: '#f5e6d3', department: '#d6e8d6', individual: '#d3e4f5' };
  var tierText   = { company: '#7a3010', department: '#1a5c1a', individual: '#0a3d6b' };

  tbody.innerHTML = filtered.map(function(g) {
    var tier = g.goalTier || inferTier(g);
    var actual = (g.storedActual !== null && g.storedActual !== undefined && g.storedActual !== '') ? g.storedActual : '—';
    var achievement = '—';
    if (actual !== '—') {
      var lb = g.lowerBetter !== false;
      var ach = lb ? (parseFloat(g.goalValue)/parseFloat(actual))*100 : (parseFloat(actual)/parseFloat(g.goalValue))*100;
      achievement = ach.toFixed(1) + '%';
    }
    var achColor = actual === '—' ? 'var(--text-muted)' : (parseFloat(achievement) >= 100 ? '#2D6B1A' : '#703c2e');
    var tdC = function(v,x) { return '<td style="padding:7px 10px;'+border+colCtx+(x||'')+'">'+escAttr(String(v===null||v===undefined?'—':v))+'</td>'; };
    var tdG = function(v,x) { return '<td style="padding:7px 10px;'+border+colGoal+(x||'')+'">'+escAttr(String(v===null||v===undefined?'—':v))+'</td>'; };
    return '<tr>' +
      '<td style="padding:7px 10px;'+border+colCtx+'">' +
        '<span style="font-size:10px;padding:2px 7px;border-radius:99px;background:'+(tierColors[tier]||'#eee')+';color:'+(tierText[tier]||'#333')+';font-weight:600;">' + tier.charAt(0).toUpperCase()+tier.slice(1) + '</span>' +
      '</td>' +
      tdC(g.department||'—') + tdC(g.role||'—') +
      '<td style="padding:7px 10px;'+border+colGoal+'font-weight:600;">'+escAttr(g.name||'')+'</td>' +
      tdG(g.weight+'%') + tdG(g.goalValue) + tdG(g.minValue) +
      tdC(actual, 'background:#f5f8f3;font-weight:600;color:'+(actual==='—'?'var(--text-muted)':'var(--text)')+';') +
      '<td style="padding:7px 10px;'+border+'background:#f5f8f3;font-weight:700;color:'+achColor+';">'+achievement+'</td>' +
    '</tr>';
  }).join('');
}

function loadSavedGoalsPreview() {
  var periodLabel = getSetupPeriodLabel();
  var section = document.getElementById('saved-goals-preview');
  var list = document.getElementById('saved-goals-list');
  var title = document.getElementById('saved-goals-title');
  if (!periodLabel || !section) return;

  var locEl = goalTier === 'individual' ? document.getElementById('setup-location') :
              goalTier === 'department' ? document.getElementById('setup-dept-location') : null;
  var deptEl = goalTier === 'individual' ? document.getElementById('setup-dept') :
               goalTier === 'department' ? document.getElementById('setup-dept-only') : null;
  var roleEl = goalTier === 'individual' ? document.getElementById('setup-role') : null;
  var location = locEl ? locEl.value : '';
  var dept = deptEl ? deptEl.value : '';
  var role = roleEl ? roleEl.value.trim() : '';

  apiGetGoals({ month: periodLabel, goalTier: goalTier, location: location, department: dept, role: role })
    .then(function(data) {
      var goals = data && data.goals ? data.goals : [];
      if (goals.length === 0) { section.style.display = 'none'; return; }

      var tierLabel = goalTier === 'company' ? 'Company' : goalTier === 'department' ? 'Department (' + dept + ' — ' + location + ')' : role + ' (' + dept + ', ' + location + ')';
      title.textContent = 'Saved goals — ' + tierLabel + ' — ' + periodLabel;
      section.style.display = 'block';

      list.innerHTML = goals.map(function(g) {
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">' +
          '<div>' +
            '<div style="font-size:13px;font-weight:600;color:var(--text);">' + escAttr(g.name) + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-top:3px;font-family:var(--mono);">' +
              'Target: ' + g.goalValue + ' &nbsp;|&nbsp; Min: ' + g.minValue +
              (g.capped === 'yes' ? ' &nbsp;|&nbsp; Cap: ' + g.capPct + '%' : '') +
              ' &nbsp;|&nbsp; Lower is better: ' + (g.lowerBetter ? 'Yes' : 'No') +
            '</div>' +
          '</div>' +
          '<span style="font-size:14px;font-weight:700;color:var(--brick);font-family:var(--mono);white-space:nowrap;margin-left:12px;">' + g.weight + '%</span>' +
        '</div>';
      }).join('') +
      '<div style="display:flex;justify-content:space-between;padding:10px 0 0;font-size:12px;font-family:var(--mono);color:var(--text-muted);">' +
        '<span>' + goals.length + ' goal' + (goals.length !== 1 ? 's' : '') + '</span>' +
        '<span style="font-weight:700;color:var(--text);">Total weight: ' + goals.reduce(function(s,g) { return s + (parseFloat(g.weight)||0); }, 0).toFixed(0) + '%</span>' +
      '</div>';
    });
}

function debugStorage() {
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    var v = localStorage.getItem(k);
    try {
      var parsed = JSON.parse(v);
    } catch(e) {
    }
  }
}

function toggleScorecardDetail(id, row) {
  var detail = document.getElementById(id);
  var chevron = row.querySelector('.sc-chevron');
  if (!detail) return;
  var isOpen = detail.style.display !== 'none';
  detail.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.innerHTML = isOpen ? '&#8964;' : '&#8963;';
}

function clearAllGoalsForMonth() {
  var month = getSetupPeriodLabel();
  if (!month) { showToast('Select a month first', 'error'); return; }
  if (!confirm('Clear ALL goals for ' + month + '? This cannot be undone.')) return;
  storageSaveGoals(month, []).then(function() {
    showToast('All goals cleared for ' + month, 'success');
    document.getElementById('saved-goals-preview').style.display = 'none';
    document.getElementById('saved-individual-goals-preview').style.display = 'none';
    document.getElementById('saved-dept-goals-preview').style.display = 'none';
    document.getElementById('saved-company-goals-preview').style.display = 'none';
    loadSetupPresetGoals();
  });
}

async function loadSubmittedScorecardsPreview() {
  var month = getActualsPeriodLabel();
  var section = document.getElementById('submitted-scorecards-section');
  var list = document.getElementById('submitted-scorecards-list');
  var title = document.getElementById('submitted-scorecards-title');
  if (!month || !section) return;

  var location = document.getElementById('emp-location').value;
  var dept = document.getElementById('emp-dept').value;

  var allScorecards = await storageGetScorecards(month);
  // Filter by location and dept if selected
  var scorecards = allScorecards.filter(function(s) {
    if (location && s.location !== location) return false;
    if (dept && s.department !== dept) return false;
    return true;
  });

  if (scorecards.length === 0 || !location || !dept) { section.style.display = 'none'; return; }

  section.style.display = 'block';
  var filterLabel = (location && dept) ? location + ' — ' + dept : (location || dept || 'All');
  title.textContent = 'Submitted scorecards — ' + filterLabel + ' — ' + month + ' (' + scorecards.length + ')';

  // Sort by dept, then name
  scorecards.sort(function(a, b) {
    if ((a.department||'') !== (b.department||'')) return (a.department||'') < (b.department||'') ? -1 : 1;
    return (a.employeeName||'') < (b.employeeName||'') ? -1 : 1;
  });

  var totalBonus = scorecards.reduce(function(s, sc) { return s + (parseFloat(sc.bonusAmount)||0); }, 0);

  list.innerHTML = scorecards.map(function(sc, idx) {
    var capped = sc.scorecardCapped ? ' <span style="font-size:10px;background:#FFF8E1;color:#8C5A00;padding:2px 6px;border-radius:99px;font-family:var(--mono);">capped</span>' : '';
    var high = (!sc.scorecardCapped && parseFloat(sc.weightedAchievement) >= 120) ? ' <span style="font-size:10px;background:#edeae4;color:#525143;padding:2px 6px;border-radius:99px;font-family:var(--mono);">120%+</span>' : '';
    var detailId = 'sc-detail-' + idx;
    var goalsHtml = (sc.goals||[]).map(function(g) {
      return '<tr style="border-bottom:1px solid var(--border);">' +
        '<td style="padding:6px 8px;font-size:12px;color:var(--text);">' + escAttr(g.name) + '</td>' +
        '<td style="padding:6px 8px;font-size:12px;text-align:center;color:var(--text-muted);font-family:var(--mono);">' + g.weight + '%</td>' +
        '<td style="padding:6px 8px;font-size:12px;text-align:center;color:var(--text-muted);font-family:var(--mono);">' + g.goalValue + '</td>' +
        '<td style="padding:6px 8px;font-size:12px;text-align:center;color:var(--text-muted);font-family:var(--mono);">' + g.actualValue + '</td>' +
        '<td style="padding:6px 8px;font-size:12px;text-align:center;font-weight:700;font-family:var(--mono);color:' + (belowMin ? '#9B2C2C' : ach >= 100 ? '#2D6B1A' : '#703c2e') + ';">' + (belowMin ? 'Below min' : ach.toFixed(1)+'%') + '</td>' +
        '<td style="padding:6px 8px;font-size:12px;text-align:right;font-family:var(--mono);color:var(--text);">$' + parseFloat(g.bonusContribution||0).toFixed(2) + '</td>' +
      '</tr>';
    }).join('');
    return '<div style="border-bottom:1px solid var(--border);">' +
      '<div data-detail="' + detailId + '" onclick="toggleScorecardDetail(this.dataset.detail, this)" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;cursor:pointer;">' +
        '<div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--text);">' + escAttr(sc.employeeName) + capped + high + '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;font-family:var(--mono);">' +
            escAttr(sc.role) + ' &middot; ' + escAttr(sc.department) + ' &middot; ' + escAttr(sc.location) +
            ' &middot; Achievement: ' + parseFloat(sc.weightedAchievement||0).toFixed(1) + '%' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<span style="font-size:14px;font-weight:700;color:var(--brick);font-family:var(--mono);">$' + parseFloat(sc.bonusAmount||0).toFixed(2) + '</span>' +
          '<span style="font-size:16px;color:var(--text-muted);" class="sc-chevron">&#8964;</span>' +
        '</div>' +
      '</div>' +
      '<div id="' + detailId + '" style="display:none;padding-bottom:12px;">' +
        '<div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:10px;font-size:11px;font-family:var(--mono);color:var(--text-muted);">' +
          '<span>Pay type: ' + (sc.payType||'hourly') + '</span>' +
          '<span>Base earnings: $' + parseFloat(sc.baseEarnings||0).toFixed(2) + '</span>' +
          '<span>Manager: ' + escAttr(sc.manager||'—') + '</span>' +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse;">' +
          '<thead><tr style="background:var(--surface2);">' +
            '<th style="padding:6px 8px;font-size:10px;font-family:var(--mono);text-align:left;color:var(--text-muted);font-weight:600;">Goal</th>' +
            '<th style="padding:6px 8px;font-size:10px;font-family:var(--mono);text-align:center;color:var(--text-muted);font-weight:600;">Weight</th>' +
            '<th style="padding:6px 8px;font-size:10px;font-family:var(--mono);text-align:center;color:var(--text-muted);font-weight:600;">Target</th>' +
            '<th style="padding:6px 8px;font-size:10px;font-family:var(--mono);text-align:center;color:var(--text-muted);font-weight:600;">Actual</th>' +
            '<th style="padding:6px 8px;font-size:10px;font-family:var(--mono);text-align:center;color:var(--text-muted);font-weight:600;">Achievement</th>' +
            '<th style="padding:6px 8px;font-size:10px;font-family:var(--mono);text-align:right;color:var(--text-muted);font-weight:600;">Bonus $</th>' +
          '</tr></thead>' +
          '<tbody>' + goalsHtml + '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';
  }).join('') +
  '<div style="display:flex;justify-content:space-between;padding:10px 0 0;font-size:12px;font-family:var(--mono);font-weight:700;">' +
    '<span style="color:var(--text-muted);">' + scorecards.length + ' employee' + (scorecards.length !== 1 ? 's' : '') + '</span>' +
    '<span style="color:var(--brick);">Total bonuses: $' + totalBonus.toFixed(2) + '</span>' +
  '</div>';
}

// ── History ────────────────────────────────────────────────────
var _historyAll = [];
var _historyFiltered = [];

function historyPopulateGoals() {
  var sel = document.getElementById('history-goal');
  if (!sel) return;
  var goals = bankGoals.filter(function(g){ return g.active !== false; });
  var names = [];
  goals.forEach(function(g){ if (names.indexOf(g.name) === -1) names.push(g.name); });
  names.sort();
  sel.innerHTML = '<option value="">All goals</option>' +
    names.map(function(n){ return '<option value="'+escAttr(n)+'">'+escAttr(n)+'</option>'; }).join('');
}

async function runHistorySearch() {
  // If Supabase is available, load from there
  if (sb && currentUser) {
    var periodEl  = document.getElementById('history-month');
    var searchEl  = document.getElementById('history-search');
    var locationEl = document.getElementById('history-location');
    var deptEl    = document.getElementById('history-dept');
    var goalEl = document.getElementById('history-goal');
    var filters = {
      period:   periodEl   && periodEl.value   ? formatMonthLabel(periodEl.value)   : null,
      search:   searchEl   && searchEl.value   ? searchEl.value.toLowerCase()       : null,
      location: locationEl && locationEl.value ? locationEl.value                   : null,
      department: deptEl   && deptEl.value     ? deptEl.value                       : null,
      goal:     goalEl     && goalEl.value     ? goalEl.value                       : null
    };
    var data = await sbLoadScorecards(filters);
    // Apply goal filter client-side if set
    if (filters.goal) {
      data = data.map(function(sc) {
        var copy = Object.assign({}, sc);
        if (copy.goals) copy.goals = copy.goals.filter(function(g){ return g.name === filters.goal; });
        return copy;
      }).filter(function(sc){ return !sc.goals || sc.goals.length > 0; });
    }
    _historyAll      = data;
    _historyFiltered = data;
    var rs = document.getElementById('history-results-section');
    var es = document.getElementById('history-empty-section');
    if (data.length === 0) { if(rs) rs.style.display='none'; if(es) es.style.display='block'; }
    else { if(es) es.style.display='none'; renderHistory(); }
    return;
  }
  var monthEl = document.getElementById('history-month');
  var month = monthEl && monthEl.value ? formatMonthLabel(monthEl.value) : '';
  var search = document.getElementById('history-search').value.trim();
  var loc = document.getElementById('history-location').value;
  var dept = document.getElementById('history-dept').value;

  // Require at least one filter
  if (!month && !search && !loc && !dept) {
    showToast('Enter at least one search filter', 'error');
    return;
  }

  if (!month) {
    _historyAll = await loadAllScorecards();
  } else {
    _historyAll = await storageGetScorecards(month);
    _historyAll = _historyAll.map(function(s) { if (!s._month) s._month = month; return s; });
  }
  filterHistory();
}

async function loadHistory() {
  // Don't auto-load — wait for user to click Search
  _historyAll = [];
  _historyFiltered = [];
  document.getElementById('history-results-section').style.display = 'none';
  document.getElementById('history-empty-section').style.display = 'none';
}

async function loadAllScorecards() {
  var all = [];
  var months = [];

  // Try months index first
  try {
    var idx = await storageGet('scorecards-months-index');
    if (idx) months = JSON.parse(idx);
  } catch(e) {}

  // Also scan localStorage for any months not in index
  for (var j = 0; j < localStorage.length; j++) {
    var k = localStorage.key(j);
    if (k && k.indexOf('scorecards:') === 0) {
      var m = k.replace('scorecards:', '');
      if (months.indexOf(m) === -1) months.push(m);
    }
  }

  // Load scorecards for each month
  for (var i = 0; i < months.length; i++) {
    try {
      var scs = await storageGetScorecards(months[i]);
      scs.forEach(function(s) { if (!s._month) s._month = months[i]; });
      all = all.concat(scs);
    } catch(e) {}
  }

  return all;
}

function filterHistory() {
  var search = (document.getElementById('history-search').value || '').toLowerCase();
  var locFilter = document.getElementById('history-location').value;
  var deptFilter = document.getElementById('history-dept').value;
  var goalFilter = document.getElementById('history-goal') ? document.getElementById('history-goal').value : '';

  _historyFiltered = _historyAll.filter(function(s) {
    if (locFilter && s.location !== locFilter) return false;
    if (deptFilter && s.department !== deptFilter) return false;
    if (search) {
      var haystack = ((s.employeeName||'') + ' ' + (s.department||'') + ' ' + (s.location||'') + ' ' + (s.role||'') + ' ' + (s._month||'')).toLowerCase();
      if (haystack.indexOf(search) === -1) return false;
    }
    return true;
  });

  // If goal filter set, narrow goals within each scorecard and show comparison
  if (goalFilter) {
    _historyFiltered = _historyFiltered.map(function(s) {
      var copy = Object.assign({}, s);
      if (copy.goals) copy.goals = copy.goals.filter(function(g){ return g.name === goalFilter; });
      return copy;
    }).filter(function(s){ return !s.goals || s.goals.length > 0; });
  }

  renderHistory();
}

var _historyView = 'spreadsheet';

function setHistoryView(view) {
  _historyView = view;
  var ss = document.getElementById('hist-view-spreadsheet');
  var sc = document.getElementById('hist-view-scorecard');
  if (ss) { ss.style.background = view==='spreadsheet'?'var(--brick)':'none'; ss.style.color = view==='spreadsheet'?'#fff':'var(--text-muted)'; ss.style.borderColor = view==='spreadsheet'?'var(--brick)':'var(--border)'; }
  if (sc) { sc.style.background = view==='scorecard'?'var(--brick)':'none'; sc.style.color = view==='scorecard'?'#fff':'var(--text-muted)'; sc.style.borderColor = view==='scorecard'?'var(--brick)':'var(--border)'; }
  renderHistory();
}

function renderHistory() {
  var resultsSection = document.getElementById('history-results-section');
  var emptySection = document.getElementById('history-empty-section');
  var list = document.getElementById('history-results-list');
  var title = document.getElementById('history-results-title');

  // Goal comparison mode
  var goalFilter = document.getElementById('history-goal') ? document.getElementById('history-goal').value : '';
  if (goalFilter && _historyFiltered.length > 0) {
    if (resultsSection) resultsSection.style.display = 'block';
    if (emptySection) emptySection.style.display = 'none';
    if (title) title.textContent = _historyFiltered.length + ' result(s) — "' + goalFilter + '" comparison';
    if (list) {
      // Build comparison table: Period | Employee | Dept | Location | Target | Actual | Achieve%
      var thS = 'padding:7px 10px;text-align:left;font-size:10px;font-weight:700;color:var(--text-muted);background:var(--surface2);border-bottom:2px solid var(--border);white-space:nowrap;';
      var rows = [];
      _historyFiltered.forEach(function(sc) {
        (sc.goals||[]).forEach(function(g) {
          var ach = g.achievement !== undefined ? g.achievement : '—';
          var achColor = typeof ach === 'number' ? (ach >= 100 ? '#2D6B1A' : '#703c2e') : 'var(--text-muted)';
          rows.push({
            period: sc._month || sc.scorecardMonth || '',
            employee: sc.employeeName || '',
            dept: sc.department || '',
            location: sc.location || '',
            target: g.goalValue !== undefined ? g.goalValue : '—',
            actual: g.actualValue !== undefined ? g.actualValue : '—',
            ach: ach,
            achColor: achColor
          });
        });
      });
      // Sort by period then employee
      rows.sort(function(a,b){ return (a.period+a.employee).localeCompare(b.period+b.employee); });

      list.innerHTML = '<div style="overflow-x:auto;">'+
        '<table style="width:100%;border-collapse:collapse;font-size:12px;">'+
          '<thead><tr>'+
            '<th style="'+thS+'">Period</th>'+
            '<th style="'+thS+'">Employee</th>'+
            '<th style="'+thS+'">Department</th>'+
            '<th style="'+thS+'">Location</th>'+
            '<th style="'+thS+'text-align:center;">Target</th>'+
            '<th style="'+thS+'text-align:center;">Actual</th>'+
            '<th style="'+thS+'text-align:center;">Achieve%</th>'+
          '</tr></thead>'+
          '<tbody>'+rows.map(function(r,i) {
            var bg = i%2===0?'background:#fff;':'background:var(--surface2);';
            var border = 'border-bottom:1px solid var(--border);';
            var td = 'padding:7px 10px;'+border+bg;
            return '<tr>'+
              '<td style="'+td+'font-family:var(--mono);font-size:11px;">'+escAttr(r.period)+'</td>'+
              '<td style="'+td+'font-weight:600;">'+escAttr(r.employee)+'</td>'+
              '<td style="'+td+'">'+escAttr(r.dept)+'</td>'+
              '<td style="'+td+'">'+escAttr(r.location)+'</td>'+
              '<td style="'+td+'text-align:center;font-family:var(--mono);">'+escAttr(String(r.target))+'</td>'+
              '<td style="'+td+'text-align:center;font-family:var(--mono);">'+escAttr(String(r.actual))+'</td>'+
              '<td style="'+td+'text-align:center;font-family:var(--mono);font-weight:700;color:'+r.achColor+';">'+(typeof r.ach==='number'?r.ach.toFixed(1)+'%':escAttr(String(r.ach)))+'</td>'+
            '</tr>';
          }).join('')+
          '</tbody>'+
        '</table>'+
      '</div>';
    }
    return;
  }

  if (_historyFiltered.length === 0) {
    resultsSection.style.display = 'none';
    emptySection.style.display = _historyAll.length > 0 ? 'block' : 'none';
    return;
  }

  emptySection.style.display = 'none';
  resultsSection.style.display = 'block';
  title.textContent = _historyFiltered.length + ' scorecard' + (_historyFiltered.length !== 1 ? 's' : '') + ' found';

  if (_historyView === 'scorecard') { renderHistoryScorecard(); return; }

  // Sort by month desc, then name
  var sorted = _historyFiltered.slice().sort(function(a, b) {
    if ((a._month||'') !== (b._month||'')) return (a._month||'') > (b._month||'') ? -1 : 1;
    return (a.employeeName||'') < (b.employeeName||'') ? -1 : 1;
  });

  var totalBonus = sorted.reduce(function(s, sc) { return s + (parseFloat(sc.bonusAmount)||0); }, 0);

  // Build flat spreadsheet — one row per goal
  var thS = 'padding:5px 7px;text-align:left;font-size:9px;font-weight:700;color:var(--text-muted);background:var(--surface2);border-bottom:2px solid var(--border);white-space:nowrap;';
  var colCtx='background:#faf8f5;', colGoal='background:#f2f7fa;', colAct='background:#f5f8f3;', colPay='background:#f9f5f8;';
  var border='border-bottom:1px solid var(--border);';
  var td = function(v,bg,x){ return '<td style="padding:5px 7px;'+border+(bg||'')+(x||'')+'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;font-size:11px;font-family:var(--mono);">'+escAttr(String(v===null||v===undefined?'—':v))+'</td>'; };

  var thead = '<colgroup>' +
    '<col style="width:75px"><col style="width:130px"><col style="width:95px"><col style="width:60px">' +
    '<col style="width:52px"><col style="width:115px"><col style="width:52px"><col style="width:52px"><col style="width:52px">' +
    '<col style="width:60px"><col style="width:58px"><col style="width:68px"><col style="width:70px">' +
    '</colgroup><thead><tr>'+
    '<th style="'+thS+colCtx+'">Period</th>'+
    '<th style="'+thS+colCtx+'">Employee</th>'+
    '<th style="'+thS+colCtx+'">Role</th>'+
    '<th style="'+thS+colCtx+'">Location</th>'+
    '<th style="'+thS+colGoal+'">Type</th>'+
    '<th style="'+thS+colGoal+'">Goal</th>'+
    '<th style="'+thS+colGoal+'">Weight</th>'+
    '<th style="'+thS+colGoal+'">Target</th>'+
    '<th style="'+thS+colGoal+'">Min</th>'+
    '<th style="'+thS+colAct+'">Actual</th>'+
    '<th style="'+thS+colAct+'">Achieve%</th>'+
    '<th style="'+thS+'background:#fff;width:30px;"></th>'+
    '<th style="'+thS+colPay+'">Base Earnings</th>'+
    '<th style="'+thS+colPay+'">Bonus $</th>'+
    '</tr></thead>';

  var tierColors={company:'#f5e6d3',department:'#d6e8d6',individual:'#d3e4f5'};
  var tierText={company:'#7a3010',department:'#1a5c1a',individual:'#0a3d6b'};

  var rows = [];
  sorted.forEach(function(sc) {
    var base = parseFloat(sc.baseEarnings||0);
    var bonusPotPct = parseFloat(sc.bonusPotentialPct||10);
    var month = sc._month||sc.scorecardMonth||'';
    (sc.goals||[]).forEach(function(g) {
      var ach = parseFloat(g.achievement||0);
      var weight = parseFloat(g.weight||0);
      var belowMin = false;
      if (g.actualValue!==undefined&&g.actualValue!==null&&g.minValue!==undefined) {
        var lb2 = g.lowerBetter!==false;
        var minV2 = parseFloat(g.minValue), actualV2 = parseFloat(g.actualValue);
        if (!isNaN(minV2)&&!isNaN(actualV2)) { if (!(lb2?actualV2<=minV2:actualV2>=minV2)) { belowMin=true; ach=0; } }
      }
      var bonusC = belowMin ? 0 : (g.bonusContribution!=null ? parseFloat(g.bonusContribution) : base*(ach/100)*(weight/100)*(bonusPotPct/100));
      var tier = g.goalTier||'individual';
      var achColor = belowMin ? '#9B2C2C' : (ach>=100?'#2D6B1A':'#703c2e');
      var achStr = belowMin ? 'Below min' : ach.toFixed(1)+'%';
      rows.push(
        '<tr>'+
        td(month,colCtx)+
        '<td style="padding:5px 7px;'+border+colCtx+'font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;">'+escAttr(sc.employeeName||'')+'</td>'+
        td(sc.role||'',colCtx)+td(sc.location||'',colCtx)+
        '<td style="padding:5px 7px;'+border+colGoal+'">'+
          '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:'+(tierColors[tier]||'#eee')+';color:'+(tierText[tier]||'#333')+';font-weight:700;">'+(tier==='company'?'Co':tier==='department'?'Dept':'Indiv')+'</span>'+
        '</td>'+
        '<td style="padding:5px 7px;'+border+colGoal+'font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;">'+escAttr(g.name||'')+'</td>'+
        td(weight+'%',colGoal)+td(g.goalValue,colGoal)+td(g.minValue,colGoal)+
        td(g.actualValue!==undefined&&g.actualValue!==null?g.actualValue:'—',colAct)+
        '<td style="padding:5px 7px;'+border+colAct+'font-weight:700;font-size:10px;color:'+achColor+';">'+achStr+'</td>'+
        '<td style="padding:5px 7px;'+border+colPay+'font-size:11px;font-family:var(--mono);">$'+base.toFixed(2)+'</td>'+
        '<td style="padding:5px 7px;'+border+colPay+'font-size:11px;font-weight:600;color:var(--brick);font-family:var(--mono);">$'+bonusC.toFixed(2)+'</td>'+
        '</tr>'
      );
    });
    // If no goals, show summary row
    if (!sc.goals||!sc.goals.length) {
      rows.push('<tr>'+td(month,colCtx)+'<td style="padding:5px 7px;'+border+colCtx+'font-size:11px;font-weight:600;">'+escAttr(sc.employeeName||'')+'</td>'+td(sc.role||'',colCtx)+td(sc.location||'',colCtx)+'<td colspan="5" style="padding:5px 7px;'+border+'font-size:11px;color:var(--text-muted);">No goal detail</td><td style="padding:5px 7px;'+border+colPay+'">$'+base.toFixed(2)+'</td><td style="padding:5px 7px;'+border+colPay+'font-weight:600;color:var(--brick);">$'+parseFloat(sc.bonusAmount||0).toFixed(2)+'</td></tr>');
    }
  });

  list.innerHTML = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;table-layout:fixed;">'+thead+'<tbody>'+rows.join('')+'</tbody></table></div>'+
    '<div style="padding:10px 0 0;font-size:12px;font-family:var(--mono);color:var(--text-muted);">'+
      sorted.length+' scorecard'+(sorted.length!==1?'s':'')+
    '</div>';
}

function histToggleScorecard(btn, detailId) {
  var d = document.getElementById(detailId);
  if (!d) return;
  var open = d.style.display !== 'none';
  d.style.display = open ? 'none' : 'block';
  var chev = btn.querySelector('.sc-chev');
  if (chev) chev.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)';
}

function renderHistoryScorecard() {
  var list = document.getElementById('history-results-list');
  if (!list) return;

  var sorted = _historyFiltered.slice().sort(function(a,b){
    if ((a._month||'')!==(b._month||'')) return (a._month||'')>(b._month||'')?-1:1;
    return (a.employeeName||'')<(b.employeeName||'')?-1:1;
  });

  var tierColors={company:'#f5e6d3',department:'#d6e8d6',individual:'#d3e4f5'};
  var tierText={company:'#7a3010',department:'#1a5c1a',individual:'#0a3d6b'};

  list.innerHTML = sorted.map(function(sc, idx) {
    var capped = sc.scorecardCapped?'<span style="font-size:10px;background:#FFF8E1;color:#8C5A00;padding:2px 6px;border-radius:99px;font-family:var(--mono);margin-left:6px;">Capped</span>':'';
    var high = (!sc.scorecardCapped&&parseFloat(sc.weightedAchievement||0)>=120)?'<span style="font-size:10px;background:#eef5ec;color:#1a5c1a;padding:2px 6px;border-radius:99px;font-family:var(--mono);margin-left:6px;">120%+</span>':'';
    var base = parseFloat(sc.baseEarnings||0);
    var bonusPotPct = parseFloat(sc.bonusPotentialPct||10);

    var goalsHTML = (sc.goals||[]).map(function(g) {
      var ach = parseFloat(g.achievement||0);
      var weight = parseFloat(g.weight||0);
      var belowMin = false;
      if (g.actualValue!=null&&g.minValue!=null) {
        var lb=g.lowerBetter!==false, minV=parseFloat(g.minValue), actV=parseFloat(g.actualValue);
        if (!isNaN(minV)&&!isNaN(actV)&&!(lb?actV<=minV:actV>=minV)) { belowMin=true; ach=0; }
      }
      var bonusC = belowMin?0:(g.bonusContribution!=null?parseFloat(g.bonusContribution):base*(ach/100)*(weight/100)*(bonusPotPct/100));
      var tier = g.goalTier||'individual';
      var achStr = belowMin?'Below min':ach.toFixed(1)+'%';
      var achCol = belowMin?'#9B2C2C':(ach>=100?'#2D6B1A':'#703c2e');
      return '<tr style="border-bottom:1px solid var(--border);">'+
        '<td style="padding:6px 10px;font-size:12px;"><span style="font-size:9px;padding:1px 5px;border-radius:99px;background:'+(tierColors[tier]||'#eee')+';color:'+(tierText[tier]||'#333')+';font-weight:700;margin-right:6px;">'+(tier==='company'?'Co':tier==='department'?'Dept':'Indiv')+'</span>'+escAttr(g.name||'')+'</td>'+
        '<td style="padding:6px 10px;font-size:12px;text-align:center;color:var(--text-muted);font-family:var(--mono);">'+weight+'%</td>'+
        '<td style="padding:6px 10px;font-size:12px;text-align:center;color:var(--text-muted);font-family:var(--mono);">'+(g.goalValue||'—')+'</td>'+
        '<td style="padding:6px 10px;font-size:12px;text-align:center;font-family:var(--mono);">'+(g.actualValue!=null?g.actualValue:'—')+'</td>'+
        '<td style="padding:6px 10px;font-size:12px;text-align:center;font-weight:700;font-family:var(--mono);color:'+achCol+';">'+achStr+'</td>'+
        '<td style="padding:6px 10px;font-size:12px;text-align:right;font-weight:600;font-family:var(--mono);color:var(--brick);">$'+bonusC.toFixed(2)+'</td>'+
      '</tr>';
    }).join('');

    var detailId = 'hist-sc-detail-'+idx;
    return '<div style="border:1.5px solid var(--border);border-radius:var(--radius);margin-bottom:12px;overflow:hidden;">'+
      '<div onclick="histToggleScorecard(this,\'' + detailId + '\')" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;cursor:pointer;background:var(--surface);">'+
        '<div>'+
          '<div style="font-size:10px;color:var(--text-muted);font-family:var(--mono);margin-bottom:3px;">'+escAttr(sc._month||sc.scorecardMonth||'')+'</div>'+
          '<div style="font-size:14px;font-weight:700;color:var(--text);">'+escAttr(sc.employeeName||'')+capped+high+'</div>'+
          '<div style="font-size:11px;color:var(--text-muted);margin-top:3px;font-family:var(--mono);">'+escAttr(sc.role||'')+' &middot; '+escAttr(sc.department||'')+' &middot; '+escAttr(sc.location||'')+'</div>'+
        '</div>'+
        '<div style="display:flex;align-items:center;gap:12px;">'+
          '<div style="text-align:right;">'+
            '<div style="font-size:10px;color:var(--text-muted);font-family:var(--mono);">Achievement</div>'+
            '<div style="font-size:14px;font-weight:700;color:'+(parseFloat(sc.weightedAchievement||0)>=100?'#2D6B1A':'#703c2e')+';">'+parseFloat(sc.weightedAchievement||0).toFixed(1)+'%</div>'+
          '</div>'+
          '<div style="text-align:right;">'+
            '<div style="font-size:10px;color:var(--text-muted);font-family:var(--mono);">Bonus</div>'+
            '<div style="font-size:14px;font-weight:700;color:var(--brick);">$'+parseFloat(sc.bonusAmount||0).toFixed(2)+'</div>'+
          '</div>'+
          '<span class="sc-chev" style="font-size:18px;color:var(--text-muted);transition:transform 0.2s;">&#8964;</span>'+
        '</div>'+
      '</div>'+
      '<div id="'+detailId+'" style="display:none;border-top:1.5px solid var(--border);">'+
        '<div style="padding:10px 16px;background:var(--surface2);display:flex;flex-wrap:wrap;gap:16px;font-size:11px;font-family:var(--mono);color:var(--text-muted);">'+
          '<span>Pay type: '+(sc.payType||'hourly')+'</span>'+
          '<span>Base earnings: $'+parseFloat(sc.baseEarnings||0).toFixed(2)+'</span>'+
          (sc.hours ? '<span>Hours: '+sc.hours+'</span>' : '')+
          '<span>Manager: '+escAttr(sc.manager||'—')+'</span>'+
        '</div>'+
        (goalsHTML?
          '<table style="width:100%;border-collapse:collapse;">'+
          '<thead><tr style="background:var(--surface2);">'+
            '<th style="padding:6px 10px;text-align:left;font-size:10px;font-weight:700;color:var(--text-muted);">Goal</th>'+
            '<th style="padding:6px 10px;text-align:center;font-size:10px;font-weight:700;color:var(--text-muted);">Weight</th>'+
            '<th style="padding:6px 10px;text-align:center;font-size:10px;font-weight:700;color:var(--text-muted);">Target</th>'+
            '<th style="padding:6px 10px;text-align:center;font-size:10px;font-weight:700;color:var(--text-muted);">Actual</th>'+
            '<th style="padding:6px 10px;text-align:center;font-size:10px;font-weight:700;color:var(--text-muted);">Achieve%</th>'+
            '<th style="padding:6px 10px;text-align:right;font-size:10px;font-weight:700;color:var(--text-muted);">Bonus $</th>'+
          '</tr></thead><tbody>'+goalsHTML+'</tbody></table>'
          :'<div style="padding:12px 16px;font-size:12px;color:var(--text-muted);">No goal detail available</div>')+
      '</div>'+
    '</div>';
  }).join('') +
  '<div style="padding:8px 0 0;font-size:12px;font-family:var(--mono);color:var(--text-muted);">'+sorted.length+' scorecard'+(sorted.length!==1?'s':'')+'</div>';
}

async function exportHistoryCSV() {
  if (!_historyFiltered.length) { showToast('No results to export', 'error'); return; }
  var rows = [['Period','Employee','Department','Role','Location','Pay Type','Manager','Base Earnings','Goal Type','Goal Name','Weight','Target','Min','Lower Better','Capped','Actual','Achievement','Bonus $','Scorecard Achievement','Scorecard Bonus','Scorecard Capped']];
  _historyFiltered.forEach(function(sc) {
    var base = parseFloat(sc.baseEarnings||0);
    var bonusPotPct = parseFloat(sc.bonusPotentialPct||10);
    var month = sc._month||sc.scorecardMonth||'';
    var goals = sc.goals||[];
    if (!goals.length) {
      rows.push([month,sc.employeeName||'',sc.department||'',sc.role||'',sc.location||'',sc.payType||'',sc.manager||'',base,'','','','','','','','','','',parseFloat(sc.weightedAchievement||0).toFixed(1)+'%',parseFloat(sc.bonusAmount||0).toFixed(2),sc.scorecardCapped?'Yes':'No']);
    } else {
      goals.forEach(function(g) {
        var ach = parseFloat(g.achievement||0);
        var weight = parseFloat(g.weight||0);
        var belowMin = false;
        if (g.actualValue!=null&&g.minValue!=null) {
          var lb=g.lowerBetter!==false, minV=parseFloat(g.minValue), actV=parseFloat(g.actualValue);
          if (!isNaN(minV)&&!isNaN(actV)&&!(lb?actV<=minV:actV>=minV)) { belowMin=true; ach=0; }
        }
        var bonusC = belowMin ? 0 : (g.bonusContribution!=null ? parseFloat(g.bonusContribution) : base*(ach/100)*(weight/100)*(bonusPotPct/100));
        rows.push([
          month, sc.employeeName||'', sc.department||'', sc.role||'', sc.location||'', sc.payType||'', sc.manager||'', base,
          g.goalTier||'', g.name||'', weight+'%', g.goalValue||'', g.minValue||'',
          g.lowerBetter!==false?'Yes':'No', g.capped==='yes'?'Yes':'No',
          g.actualValue!=null?g.actualValue:'',
          belowMin?'Below min':ach.toFixed(1)+'%',
          bonusC.toFixed(2),
          parseFloat(sc.weightedAchievement||0).toFixed(1)+'%',
          parseFloat(sc.bonusAmount||0).toFixed(2),
          sc.scorecardCapped?'Yes':'No'
        ]);
      });
    }
  });
  downloadCSV(rows, 'scorecards-history.csv');
}

// ── Goals Overview ─────────────────────────────────────────────
var _overviewGoals = [];
var overviewPeriodType = 'monthly';

function toggleDropdown(id) {
  var el = document.getElementById(id);
  var isOpen = el.classList.contains('open');
  // Close all open dropdowns first
  document.querySelectorAll('.multi-select-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
  if (!isOpen) el.classList.add('open');
}

// Close dropdowns when clicking outside
document.addEventListener('click', function(e) {
  if (!e.target.closest('.multi-select-dropdown')) {
    document.querySelectorAll('.multi-select-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
  }
});

function updateDropdownLabel(dropdownId, checkboxesId, allLabel) {
  var checked = Array.from(document.querySelectorAll('#' + checkboxesId + ' input[value]:checked')).map(function(cb) { return cb.value; }).filter(Boolean);
  var total = document.querySelectorAll('#' + checkboxesId + ' input[value]:not([value=""])').length;
  var label = document.getElementById(dropdownId + '-label');
  if (!label) return;
  if (checked.length === 0) label.textContent = 'None selected';
  else if (checked.length === total) label.textContent = allLabel;
  else if (checked.length <= 2) label.textContent = checked.join(', ');
  else label.textContent = checked.length + ' selected';
}

function toggleAllDepts(allCheckbox) {
  var checked = allCheckbox.checked;
  document.querySelectorAll('#overview-dept-checkboxes input[value]').forEach(function(cb) {
    if (cb.value) cb.checked = checked;
  });
  updateDropdownLabel('dept-dropdown', 'overview-dept-checkboxes', 'All departments');
  loadOverview();
}

function setOverviewPeriod(type) {
  overviewPeriodType = type;
  document.getElementById('overview-period-monthly').className = 'period-btn' + (type === 'monthly' ? ' active' : '');
  document.getElementById('overview-period-quarterly').className = 'period-btn' + (type === 'quarterly' ? ' active' : '');
  document.getElementById('overview-monthly-field').style.display = type === 'monthly' ? '' : 'none';
  document.getElementById('overview-quarterly-field').style.display = type === 'quarterly' ? '' : 'none';
  loadOverview();
}

function getOverviewPeriodLabel() {
  if (overviewPeriodType === 'quarterly') {
    var q = document.getElementById('overview-quarter').value;
    var y = document.getElementById('overview-year').value;
    return (q && y) ? q + ' ' + y : '';
  }
  return formatMonthLabel(document.getElementById('overview-month').value);
}

var QUARTER_MONTHS = {
  'Q1': ['January', 'February', 'March'],
  'Q2': ['April', 'May', 'June'],
  'Q3': ['July', 'August', 'September'],
  'Q4': ['October', 'November', 'December']
};

async function loadOverview() {
  var month = getOverviewPeriodLabel();
  // Debug: show exact bytes of month key
  var lsVal = localStorage.getItem('goals:' + month);
  // Read checkbox filters
  var tierChecks = Array.from(document.querySelectorAll('#overview-tier-checkboxes input:checked')).map(function(cb) { return cb.value; });
  var deptChecks = Array.from(document.querySelectorAll('#overview-dept-checkboxes input[value]:checked')).map(function(cb) { return cb.value; }).filter(Boolean);
  var locFilter = document.getElementById('overview-location').value;

  if (!month) {
    document.getElementById('overview-table-section').style.display = 'none';
    document.getElementById('overview-empty').style.display = 'none';
    return;
  }

  // Debug: try multiple possible key formats
  var goals = await storageGetGoals(month);

  // If quarterly, also pull goals from each of the 3 constituent months
  if (overviewPeriodType === 'quarterly') {
    var q = document.getElementById('overview-quarter').value;
    var y = document.getElementById('overview-year').value;
    if (q && y && QUARTER_MONTHS[q]) {
      var qMonthNums = { 'Q1': [0,1,2], 'Q2': [3,4,5], 'Q3': [6,7,8], 'Q4': [9,10,11] };
      for (var mi = 0; mi < qMonthNums[q].length; mi++) {
        var mDate = new Date(parseInt(y), qMonthNums[q][mi], 1);
        var mLabel = mDate.toLocaleString('default', { month: 'long', year: 'numeric' });
        var mGoals = await storageGetGoals(mLabel);
        mGoals.forEach(function(mg) {
          var exists = goals.some(function(g) {
            return g.name === mg.name &&
              (g.goalTier||inferTier(g)) === (mg.goalTier||inferTier(mg)) &&
              g.location === mg.location && g.department === mg.department && g.role === mg.role;
          });
          if (!exists) { mg._sourceMonth = mLabel; goals.push(mg); }
        });
      }
    }
  }

  // Filter
  _overviewGoals = goals.filter(function(g) {
    var tier = g.goalTier || inferTier(g);
    if (tierChecks.length > 0 && tierChecks.indexOf(tier) === -1) return false;
    if (locFilter && g.location !== locFilter) return false;
    if (deptChecks.length > 0 && deptChecks.indexOf(g.department) === -1) return false;
    return true;
  });

  // Sort: company → department → individual, then by dept, role, name
  var tierOrder = { company: 0, department: 1, individual: 2 };
  _overviewGoals.sort(function(a, b) {
    var ta = tierOrder[a.goalTier || inferTier(a)] || 0;
    var tb = tierOrder[b.goalTier || inferTier(b)] || 0;
    if (ta !== tb) return ta - tb;
    if ((a.department||'') !== (b.department||'')) return (a.department||'') < (b.department||'') ? -1 : 1;
    if ((a.role||'') !== (b.role||'')) return (a.role||'') < (b.role||'') ? -1 : 1;
    return (a.name||'') < (b.name||'') ? -1 : 1;
  });

  if (_overviewGoals.length === 0) {
    document.getElementById('overview-table-section').style.display = 'none';
    document.getElementById('overview-empty').style.display = 'block';
    return;
  }

  document.getElementById('overview-empty').style.display = 'none';
  document.getElementById('overview-table-section').style.display = 'block';

  // Column group background colors
  var colContext  = 'background:#f0ece6;'; // Type → Role  (warm taupe)
  var colGoal     = 'background:#e8f0f5;'; // Goal Name → Capped (sage green)
  var colResults  = 'background:#eef2eb;'; // Actual + Achievement (soft blue)

  var th = function(label, bg) {
    return '<th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;color:var(--text-muted);' + bg + 'border-bottom:2px solid var(--border);white-space:nowrap;">' + label + '</th>';
  };

  document.getElementById('overview-thead').innerHTML =
    '<tr>' +
    th('Type', colContext) + th('Location', colContext) + th('Department', colContext) + th('Role', colContext) +
    th('Goal Name', colGoal) + th('Weight', colGoal) + th('Target', colGoal) + th('Min', colGoal) + th('Lower Better', colGoal) + th('Capped', colGoal) +
    th('Actual', colResults) + th('Achievement', colResults) +
    '</tr>';

  var tierColors = { company: '#f5e6d3', department: '#d6e8d6', individual: '#d3e4f5' };
  var tierTextColors = { company: '#7a3010', department: '#1a5c1a', individual: '#0a3d6b' };

  document.getElementById('overview-tbody').innerHTML = _overviewGoals.map(function(g) {
    var tier = g.goalTier || inferTier(g);
    var actual = (g.storedActual !== null && g.storedActual !== undefined && g.storedActual !== '') ? g.storedActual : '—';
    var achievement = '—';
    if (actual !== '—') {
      var lowerBetter = g.lowerBetter !== false;
      var ach = lowerBetter ? (parseFloat(g.goalValue) / parseFloat(actual)) * 100 : (parseFloat(actual) / parseFloat(g.goalValue)) * 100;
      achievement = ach.toFixed(1) + '%';
    }
    var achColor = actual === '—' ? 'var(--text-muted)' : (parseFloat(achievement) >= 100 ? '#2D6B1A' : '#703c2e');
    var td = function(val, style) {
      return '<td style="padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text);' + (style||'') + '">' + escAttr(String(val === null || val === undefined ? '—' : val)) + '</td>';
    };
    var cCtx = 'background:#faf8f5;';
    var cGoal = 'background:#f2f7fa;';
    var cRes  = 'background:#f5f8f3;';
    var border = 'border-bottom:1px solid var(--border);';
    var tdC = function(val, extra) { return '<td style="padding:8px 10px;' + border + cCtx + (extra||'') + '">' + escAttr(String(val===null||val===undefined?'—':val)) + '</td>'; };
    var tdG = function(val, extra) { return '<td style="padding:8px 10px;' + border + cGoal + (extra||'') + '">' + escAttr(String(val===null||val===undefined?'—':val)) + '</td>'; };
    var tdR = function(val, extra) { return '<td style="padding:8px 10px;' + border + cRes + (extra||'') + '">' + escAttr(String(val===null||val===undefined?'—':val)) + '</td>'; };

    return '<tr>' +
      '<td style="padding:8px 10px;' + border + cCtx + '">' +
        '<span style="font-size:10px;padding:2px 8px;border-radius:99px;background:' + (tierColors[tier]||'#eee') + ';color:' + (tierTextColors[tier]||'#333') + ';font-weight:600;white-space:nowrap;">' + tier.charAt(0).toUpperCase() + tier.slice(1) + '</span>' +
      '</td>' +
      tdC(g.location || '—') +
      tdC(g.department || '—') +
      tdC(g.role || '—') +
      '<td style="padding:8px 10px;' + border + cGoal + 'font-weight:600;color:var(--text);">' + escAttr(g.name||'') + '</td>' +
      tdG(g.weight + '%') +
      tdG(g.goalValue) +
      tdG(g.minValue) +
      tdG(g.lowerBetter !== false ? 'Yes' : 'No') +
      tdG(g.capped === 'yes' ? 'Yes (' + g.capPct + '%)' : 'No') +
      '<td style="padding:8px 10px;' + border + cRes + 'font-weight:600;color:' + (actual === '—' ? 'var(--text-muted)' : 'var(--text)') + ';">' + actual + '</td>' +
      '<td style="padding:8px 10px;' + border + cRes + 'font-weight:700;color:' + achColor + ';">' + achievement + '</td>' +
    '</tr>';
  }).join('');
}

async function exportOverviewCSV() {
  if (!_overviewGoals.length) { showToast('No goals to export', 'error'); return; }
  var rows = [['Type','Location','Department','Role','Goal Name','Weight (%)','Target','Min','Lower Better','Capped','Cap %','Actual','Achievement']];
  _overviewGoals.forEach(function(g) {
    var tier = g.goalTier || inferTier(g);
    var actual = (g.storedActual !== null && g.storedActual !== undefined && g.storedActual !== '') ? g.storedActual : '';
    var achievement = '';
    if (actual !== '') {
      var lowerBetter = g.lowerBetter !== false;
      achievement = (lowerBetter ? (parseFloat(g.goalValue)/parseFloat(actual))*100 : (parseFloat(actual)/parseFloat(g.goalValue))*100).toFixed(1) + '%';
    }
    rows.push([tier, g.location||'', g.department||'', g.role||'', g.name||'', g.weight, g.goalValue, g.minValue, g.lowerBetter!==false?'Yes':'No', g.capped==='yes'?'Yes':'No', g.capPct||'', actual, achievement]);
  });
  var periodLabel = getOverviewPeriodLabel().replace(' ', '-') || 'goals';
  downloadCSV(rows, 'goals-overview-' + periodLabel + '.csv');
}

// ── Rippling Data ──────────────────────────────────────────────
var _ripplingParsed = [];

function ripplingKey(month) { return 'rippling:' + month; }

function normalizeLocation(raw) {
  if (!raw) return '';
  var s = raw.toLowerCase();
  if (s.indexOf('utah') !== -1) return 'Utah';
  if (s.indexOf('georgia') !== -1) return 'Georgia';
  if (s.indexOf('remote') !== -1) return 'Remote';
  return raw;
}

function parseRipplingCSV(text) {
  var lines = text.split(/\r?\n/).filter(function(l) { return l.trim(); });
  if (lines.length < 2) return [];
  var headers = lines[0].split(',').map(function(h) { return h.trim().replace(/^"|"$/g,''); });

  function col(row, name) {
    var idx = headers.indexOf(name);
    if (idx < 0) return '';
    var val = row[idx] ? row[idx].trim().replace(/^"|"$/g,'') : '';
    return val;
  }

  var employees = [];
  for (var i = 1; i < lines.length; i++) {
    // Handle quoted commas
    var row = [];
    var cur = '', inQ = false;
    for (var c = 0; c < lines[i].length; c++) {
      var ch = lines[i][c];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { row.push(cur); cur = ''; }
      else { cur += ch; }
    }
    row.push(cur);

    var name = col(row, 'Full name') || col(row, 'Employee');
    if (!name) continue;

    var isSalaried  = col(row, 'Salaried').toLowerCase() === 'true';
    var isHourly    = col(row, 'Hourly').toLowerCase() === 'true';
    var hourlyRate  = parseFloat(col(row, 'hourly_rate')) || 0;
    var annualPay   = parseFloat(col(row, 'annual_base_pay')) || 0;
    var empType     = col(row, 'Employment type name').toLowerCase();
    var isFullTime  = empType.indexOf('full') !== -1;
    var flsaStatus  = col(row, 'FLSA exemption status'); // 'False' = non-exempt, 'True' = exempt
    var isExempt    = flsaStatus.toLowerCase() === 'true';

    // Base Pay = actual gross earnings for the period (includes OT for non-exempt)
    var grossEarnings = parseFloat(col(row, 'Base Pay')) || 0;
    // Fallback to other common column names
    if (!grossEarnings) grossEarnings = parseFloat(
      col(row, 'Gross earnings') || col(row, 'Gross Earnings') ||
      col(row, 'gross_earnings') || col(row, 'Total Earnings') ||
      col(row, 'Period earnings') || '0'
    ) || 0;

    var hoursWorked = parseFloat(col(row, 'Total hours worked')) || 0;
    if (!hoursWorked) hoursWorked = parseFloat(
      col(row, 'Hours worked') || col(row, 'hours_worked') ||
      col(row, 'Regular hours') || col(row, 'Total hours') || col(row, 'Hours') || '0'
    ) || 0;

    employees.push({
      name:          name,
      role:          col(row, 'Title'),
      department:    col(row, 'Department name') || col(row, 'Department'),
      location:      normalizeLocation(col(row, 'Work location name')),
      payType:       isSalaried ? 'salary' : 'hourly',
      isExempt:      isExempt,
      hourlyRate:    hourlyRate,
      annualPay:     annualPay,
      grossEarnings: grossEarnings,
      hoursWorked:   hoursWorked,
      fullTime:      isFullTime,
      empType:       col(row, 'Employment type name'),
    });
  }
  return employees;
}

function handleRipplingDrop(event) {
  event.preventDefault();
  document.getElementById('rippling-drop-zone').style.borderColor = 'var(--border-strong)';
  var file = event.dataTransfer.files[0];
  if (file) handleRipplingFile(file);
}



function renderRipplingPreview(employees) {
  var section = document.getElementById('rippling-preview-section');
  var title   = document.getElementById('rippling-preview-title');
  var thead   = document.getElementById('rippling-preview-thead');
  var tbody   = document.getElementById('rippling-preview-tbody');
  if (!employees.length) { showToast('No employees found in CSV', 'error'); return; }

  section.style.display = 'block';
  title.textContent = employees.length + ' employees ready to import';

  var thStyle = 'padding:6px 8px;text-align:left;font-size:10px;font-weight:700;color:var(--text-muted);background:var(--surface2);border-bottom:2px solid var(--border);white-space:nowrap;';
  thead.innerHTML = '<tr>' +
    ['Name','Role','Department','Location','Pay Type','Hourly Rate','Annual Pay','Gross Earnings','Hours Worked','FLSA','Employment Type'].map(function(h) {
      return '<th style="' + thStyle + '">' + h + '</th>';
    }).join('') + '</tr>';

  var border = 'border-bottom:1px solid var(--border);';
  tbody.innerHTML = employees.map(function(e) {
    var td = function(v) { return '<td style="padding:6px 8px;font-size:11px;' + border + 'color:var(--text);white-space:nowrap;">' + escAttr(String(v||'—')) + '</td>'; };
    return '<tr>' +
      td(e.name) + td(e.role) + td(e.department) + td(e.location) +
      td(e.payType === 'salary' ? 'Salary' : 'Hourly') +
      td(e.hourlyRate ? '$' + e.hourlyRate + '/hr' : '—') +
      td(e.annualPay ? '$' + parseFloat(e.annualPay).toLocaleString() + '/yr' : '—') +
      td(e.grossEarnings ? '$' + parseFloat(e.grossEarnings).toFixed(2) : '—') +
      td(e.hoursWorked ? e.hoursWorked.toFixed(2) + ' hrs' : '—') +
      td(e.isExempt ? 'Exempt' : 'Non-exempt') +
      td(e.empType) +
    '</tr>';
  }).join('');
}

async function saveRipplingData() {
  var month = formatMonthLabel(document.getElementById('rippling-month').value);
  if (!month || !_ripplingParsed.length) { showToast('Nothing to save', 'error'); return; }
  var json = JSON.stringify(_ripplingParsed);
  // Always save to localStorage
  localStorage.setItem(ripplingKey(month), json);
  var idxRaw = localStorage.getItem('rippling-months-index');
  var months = idxRaw ? JSON.parse(idxRaw) : [];
  if (months.indexOf(month) === -1) { months.push(month); localStorage.setItem('rippling-months-index', JSON.stringify(months)); }
  // Also save to Supabase
  if (sb && currentUser) {
    var sbResult = await sbSaveRippling(month, _ripplingParsed);
    if (sbResult && sbResult.error) { showToast('Supabase error: '+sbResult.error.message, 'error'); }
  }
  showToast('Saved ' + _ripplingParsed.length + ' employees for ' + month, 'success');
  loadRipplingSaved();
}

async function getRipplingEmployees(month) {
  try {
    var employees = [];
    // Try Supabase first
    if (sb && currentUser) {
      employees = await sbLoadRippling(month);
    }
    // Fallback to localStorage
    if (!employees.length) {
      var local = localStorage.getItem(ripplingKey(month));
      if (local) employees = JSON.parse(local);
    }
    // Scope to manager's dept/location if not admin
    if (currentProfile && currentProfile.role !== 'admin' && employees.length) {
      var mgDepts = currentProfile.departments || [];
      var mgLocs  = currentProfile.locations  || [];
      employees = employees.filter(function(e) {
        // Employee matches if BOTH dept and location fall within manager's scope
        // If manager has no dept restriction, show all depts; same for location
        var deptOk = mgDepts.length === 0 || !e.department || mgDepts.indexOf(e.department) !== -1;
        var locOk  = mgLocs.length  === 0 || !e.location   || mgLocs.indexOf(normalizeLocation(e.location))  !== -1;
        return deptOk && locOk;
      });
    }
    return employees;
  } catch(e) { return []; }
}



// ── Rippling Typeahead ─────────────────────────────────────────
async function ripplingTypeahead(query) {
  var suggestions = document.getElementById('rippling-suggestions');
  if (!suggestions) return;
  if (!query || query.length < 2) { suggestions.style.display = 'none'; return; }

  var month = getActualsPeriodLabel();
  var employees = month ? await getRipplingEmployees(month) : [];

  // Fallback: try current month
  if (employees.length === 0) {
    var now = new Date();
    var curLabel = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleString('default', { month: 'long', year: 'numeric' });
    if (curLabel !== month) employees = await getRipplingEmployees(curLabel);
  }

  // Fallback: scan localStorage for any rippling data
  if (employees.length === 0) {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('rippling:') === 0) {
        try {
          var d = JSON.parse(localStorage.getItem(k));
          if (d && d.length > 0) { employees = d; break; }
        } catch(e2) {}
      }
    }
  }

  // Fallback: scan window.storage index
  if (employees.length === 0) {
    try {
      var idxRaw = await storageGet('rippling-months-index');
      var months = idxRaw ? JSON.parse(idxRaw) : [];
      for (var mi = 0; mi < months.length; mi++) {
        var d2 = await getRipplingEmployees(months[mi]);
        if (d2.length > 0) { employees = d2; break; }
      }
    } catch(e3) {}
  }

  var q = query.toLowerCase();
  var matches = employees.filter(function(e) {
    return e.name && e.name.toLowerCase().indexOf(q) !== -1;
  }).slice(0, 8);

  if (matches.length === 0) { suggestions.style.display = 'none'; return; }

  suggestions.style.display = 'block';
  suggestions.innerHTML = matches.map(function(e) {
    var payInfo = e.payType === 'salary' ? '$' + parseFloat(e.annualPay||0).toLocaleString() + '/yr' : '$' + (e.hourlyRate||0) + '/hr';
    var eJson = JSON.stringify(e).replace(/"/g, '&quot;');
    return '<div onclick="selectRipplingEmployee(JSON.parse(this.dataset.emp))" data-emp="' + eJson + '" ' +
      'style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);">'+
      '<div style="font-size:13px;font-weight:600;color:var(--text);">' + escAttr(e.name) + '</div>' +
      '<div style="font-size:11px;color:var(--text-muted);font-family:var(--mono);">' + escAttr(e.role) + ' &middot; ' + escAttr(e.department) + ' &middot; ' + escAttr(e.location) + ' &middot; ' + payInfo + '</div>' +
      '</div>';
  }).join('');
}

function selectRipplingEmployee(e) {
  // Fill in all fields
  document.getElementById('emp-name').value = e.name;
  document.getElementById('rippling-suggestions').style.display = 'none';

  // Role
  var roleEl = document.getElementById('emp-role');
  if (roleEl && e.role) {
    for (var i = 0; i < roleEl.options.length; i++) {
      if (roleEl.options[i].value === e.role) { roleEl.value = e.role; break; }
    }
  }

  // Department
  var deptEl = document.getElementById('emp-dept');
  if (deptEl && e.department) deptEl.value = e.department;

  // Location
  var locEl = document.getElementById('emp-location');
  if (locEl && e.location) locEl.value = e.location;

  // Pay type
  if (e.payType) setPayType(e.payType);

  // Pay rate
  if (e.payType === 'hourly' && e.hourlyRate) {
    var hourlyEl = document.getElementById('hourly');
    if (hourlyEl) hourlyEl.value = e.hourlyRate;
  } else if (e.payType === 'salary' && e.annualPay) {
    var salaryEl = document.getElementById('hourly');
    if (salaryEl) { salaryEl.value = e.annualPay; calc(); }
  }

  // Trigger role change to load goals
  onActualsContextChange();
}

// Close suggestions on outside click
document.addEventListener('click', function(ev) {
  var sug = document.getElementById('rippling-suggestions');
  if (sug && !ev.target.closest('#emp-name') && !ev.target.closest('#rippling-suggestions')) {
    sug.style.display = 'none';
  }
});

// ── Rippling Data ──────────────────────────────────────────────
var _ripplingParsed = []; // currently parsed/previewed rows

function ripplingKey(month) { return 'rippling:' + month; }

function parseLocation(raw) {
  if (!raw) return '';
  var s = raw.toLowerCase();
  if (s.includes('utah')) return 'Utah';
  if (s.includes('georgia')) return 'Georgia';
  if (s.includes('remote')) return 'Remote';
  return raw;
}

function parseTitle(raw) {
  if (!raw) return '';
  // Normalize known variations
  return raw.trim()
    .replace('Product and Design Lead', 'Product & Design Lead')
    .replace('Senior Client Care Specialist ', 'Senior Client Care Specialist');
}

function parseCSV(text) {
  var lines = text.split(/\r?\n/).filter(function(l) { return l.trim(); });
  if (lines.length < 2) return [];
  var headers = lines[0].split(',').map(function(h) { return h.trim(); });
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    // Handle quoted fields
    var cells = [], cur = '', inQ = false;
    for (var c = 0; c < lines[i].length; c++) {
      var ch = lines[i][c];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    cells.push(cur.trim());
    var row = {};
    headers.forEach(function(h, idx) { row[h] = cells[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

function ripplingRowToEmployee(row) {
  var isHourly   = row['Hourly'] === 'True';
  var isSalaried = row['Salaried'] === 'True';
  var loc        = parseLocation(row['Work location name']);
  var grossEarnings = parseFloat(row['Base Pay']) || 0;
  var hoursWorked   = parseFloat(row['Total hours worked']) || 0;
  var isExempt      = (row['FLSA exemption status'] || '').toLowerCase() === 'true';
  return {
    name:          (row['Full name'] || '').trim(),
    role:          parseTitle(row['Title']),
    department:    (row['Department name'] || row['Department'] || '').trim(),
    location:      loc,
    manager:       (row['Manager'] || '').trim(),
    payType:       isHourly ? 'hourly' : 'salary',
    hourlyRate:    isHourly ? parseFloat(row['hourly_rate']) || 0 : 0,
    annualPay:     isSalaried ? parseFloat(row['annual_base_pay']) || 0 : 0,
    grossEarnings: grossEarnings,
    hoursWorked:   hoursWorked,
    isExempt:      isExempt,
    employmentType: (row['Employment type name'] || '').trim()
  };
}

function handleRipplingFile(file) {
  if (!file) return;
  var monthEl = document.getElementById('rippling-month');
  if (!monthEl || !monthEl.value) { showToast('Select a month before uploading', 'error'); return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    var rows = parseCSV(e.target.result);
    _ripplingParsed = rows.map(ripplingRowToEmployee).filter(function(emp) { return emp.name; });
    renderRipplingPreview(_ripplingParsed);
  };
  reader.readAsText(file);
}

async function loadRipplingSaved() {
  var section = document.getElementById('rippling-saved-section');
  var title = document.getElementById('rippling-saved-title');
  var monthEl = document.getElementById('rippling-month');
  var month = monthEl && monthEl.value ? formatMonthLabel(monthEl.value) : '';

  // Populate the saved-month dropdown from index
  var sel = document.getElementById('rippling-saved-month');
  if (sel) {
    var idxRaw = await storageGet('rippling-months-index');
    var lsMonths = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('rippling:') === 0) lsMonths.push(k.replace('rippling:', ''));
    }
    var months = idxRaw ? JSON.parse(idxRaw) : [];
    lsMonths.forEach(function(m) { if (months.indexOf(m) === -1) months.push(m); });
    months.sort().reverse();
    sel.innerHTML = '<option value="">Select month...</option>';
    months.forEach(function(m) {
      var opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      if (m === month) opt.selected = true;
      sel.appendChild(opt);
    });
    if (months.length > 0) {
      if (!month) month = months[0];
      sel.value = month;
      section.style.display = 'block';
    } else {
      section.style.display = 'none';
      return;
    }
  }

  if (!month) { if (section) section.style.display = 'none'; return; }
  var employees = await getRipplingEmployees(month);
  if (!employees.length) { if (section) section.style.display = 'none'; return; }

  if (title) title.textContent = 'Saved — ' + month + ' (' + employees.length + ' employees)';
  if (section) section.style.display = 'block';

  var thStyle = 'padding:7px 10px;text-align:left;font-size:10px;font-weight:700;color:var(--text-muted);background:var(--surface2);border-bottom:2px solid var(--border);white-space:nowrap;';
  var thead = document.getElementById('rippling-saved-thead');
  var tbody = document.getElementById('rippling-saved-tbody');
  if (thead) thead.innerHTML = '<tr>' + ['Name','Role','Department','Location','Pay Type','Rate / Annual Pay'].map(function(h) {
    return '<th style="' + thStyle + '">' + h + '</th>';
  }).join('') + '</tr>';

  var border = 'border-bottom:1px solid var(--border);';
  if (tbody) tbody.innerHTML = employees.map(function(e) {
    var payDisplay = e.payType === 'salary' ? '$' + parseFloat(e.annualPay||0).toLocaleString() + '/yr' : '$' + (e.hourlyRate||0) + '/hr';
    var td = function(v) { return '<td style="padding:7px 10px;' + border + 'color:var(--text);">' + escAttr(String(v||'')) + '</td>'; };
    return '<tr>' + td(e.name) + td(e.role) + td(e.department) + td(e.location) + td(e.payType === 'salary' ? 'Salary' : 'Hourly') + td(payDisplay) + '</tr>';
  }).join('');
}

// ── Goal Setup v2 ──────────────────────────────────────────────
var gs2Goals = []; // all goals for current period selection
var gs2EditKey = null; // null = new, else index in gs2Goals

var QUARTER_MONTHS_MAP = {
  Q1: [{label:'January',num:0},{label:'February',num:1},{label:'March',num:2}],
  Q2: [{label:'April',num:3},{label:'May',num:4},{label:'June',num:5}],
  Q3: [{label:'July',num:6},{label:'August',num:7},{label:'September',num:8}],
  Q4: [{label:'October',num:9},{label:'November',num:10},{label:'December',num:11}]
};

function gs2GetPeriodLabel() {
  var q = document.getElementById('gs2-quarter').value;
  var y = document.getElementById('gs2-year').value;
  var m = document.getElementById('gs2-month').value;
  if (!q || !y) return null;
  return m ? m : (q + ' ' + y);
}

function gs2GetAllPeriodLabels() {
  var q = document.getElementById('gs2-quarter').value;
  var y = document.getElementById('gs2-year').value;
  var m = document.getElementById('gs2-month').value;
  if (!q || !y) return [];
  if (m) return [m];
  // All months in quarter + the quarter itself
  var labels = [q + ' ' + y];
  QUARTER_MONTHS_MAP[q].forEach(function(mo) {
    labels.push(new Date(parseInt(y), mo.num, 1).toLocaleString('default', {month:'long',year:'numeric'}));
  });
  return labels;
}

function gs2UpdateMonthDropdown() {
  var q = document.getElementById('gs2-quarter').value;
  var y = document.getElementById('gs2-year').value;
  var sel = document.getElementById('gs2-month');
  sel.innerHTML = '<option value="">All months in quarter</option>';
  if (!q || !y) return;
  QUARTER_MONTHS_MAP[q].forEach(function(mo) {
    var label = new Date(parseInt(y), mo.num, 1).toLocaleString('default', {month:'long',year:'numeric'});
    var opt = document.createElement('option');
    opt.value = label; opt.textContent = mo.label + ' ' + y;
    sel.appendChild(opt);
  });
  // Also populate gs2-m-period in modal
  var msel = document.getElementById('gs2-m-period');
  if (msel) {
    msel.innerHTML = '<option value="' + q + ' ' + y + '">' + q + ' ' + y + '</option>';
    QUARTER_MONTHS_MAP[q].forEach(function(mo) {
      var label = new Date(parseInt(y), mo.num, 1).toLocaleString('default', {month:'long',year:'numeric'});
      var opt = document.createElement('option');
      opt.value = label; opt.textContent = mo.label + ' ' + y;
      msel.appendChild(opt);
    });
  }
}

// Called when quarter or year changes - resets month and reloads
async function gs2Load() {
  gs2UpdateMonthDropdown();
  document.getElementById('gs2-month').value = '';
  await gs2LoadData();
}

// Called when month dropdown changes - just reloads data
async function gs2LoadFromMonth() {
  await gs2LoadData();
}

async function gs2LoadData() {
  var labels = gs2GetAllPeriodLabels();
  if (!labels.length) return;

  var section = document.getElementById('gs2-table-section');
  var emptyPeriod = document.getElementById('gs2-empty-period');

  gs2Goals = [];
  for (var i = 0; i < labels.length; i++) {
    var goals = await storageGetGoals(labels[i]);
    goals.forEach(function(g) {
      if (!g._period) g._period = labels[i];
      gs2Goals.push(g);
    });
  }

  var title = document.getElementById('gs2-table-title');
  if (gs2Goals.length === 0) {
    section.style.display = 'none';
    emptyPeriod.style.display = 'block';
    if (title) title.textContent = 'Goals';
  } else {
    section.style.display = 'block';
    emptyPeriod.style.display = 'none';
    if (title) title.textContent = 'Goals (' + gs2Goals.length + ')';
    gs2Render();
  }
}

var _gs2ActiveMenuIdx = null;
function gs2ToggleRowMenu(idx, btn) {
  event.stopPropagation();
  var menu = document.getElementById('gs2-row-menu');
  if (_gs2ActiveMenuIdx === idx && menu.style.display !== 'none') {
    menu.style.display = 'none'; _gs2ActiveMenuIdx = null; return;
  }
  _gs2ActiveMenuIdx = idx;
  var rect = btn.getBoundingClientRect();
  menu.style.display = 'block';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = Math.min(rect.right - 130, window.innerWidth - 140) + 'px';
  document.getElementById('gs2-row-menu-edit').onclick = function() { menu.style.display='none'; _gs2ActiveMenuIdx=null; gs2OpenEdit(idx); };
  document.getElementById('gs2-row-menu-delete').onclick = function() { menu.style.display='none'; _gs2ActiveMenuIdx=null; gs2DeleteGoal(idx); };
  // Show/hide deactivate + delete based on role
  var isAdminMenu = !currentProfile || currentProfile.role === 'admin';
  document.getElementById('gs2-row-menu-delete').style.display = isAdminMenu ? '' : 'none';
  var deactivateBtn = document.getElementById('gs2-row-menu-delete');
  // Also hide deactivate option for non-admins
  if (deactivateBtn && deactivateBtn.previousElementSibling) {
    deactivateBtn.previousElementSibling.style.display = isAdminMenu ? '' : 'none';
  }
}
function gs2CloseRowMenus() {
  var menu = document.getElementById('gs2-row-menu');
  if (menu) menu.style.display = 'none';
  _gs2ActiveMenuIdx = null;
}
document.addEventListener('click', function() {
  gs2CloseRowMenus();
  var sug = document.getElementById('act2-suggestions'); if (sug) sug.style.display = 'none';
  var sug2 = document.getElementById('sc-suggestions'); if (sug2) sug2.style.display = 'none';
});

function gs2UpdateTypeLabel() {
  updateDropdownLabel('gs2-type-dd', 'gs2-type-checkboxes', 'All types');
}
function gs2UpdateDeptLabel() {
  updateDropdownLabel('gs2-dept-dd', 'gs2-dept-checkboxes', 'All departments');
}
function gs2ToggleAllDepts(cb) {
  document.querySelectorAll('#gs2-dept-checkboxes input[value]:not([value=""])').forEach(function(el) { el.checked = cb.checked; });
  gs2UpdateDeptLabel();
  gs2Render();
}

function gs2ResetFilters() {
  document.querySelectorAll('#gs2-type-checkboxes input').forEach(function(cb) { cb.checked = true; });
  document.querySelectorAll('#gs2-dept-checkboxes input').forEach(function(cb) { cb.checked = true; });
  document.getElementById('gs2-sort').value = 'type';
  gs2UpdateTypeLabel();
  gs2UpdateDeptLabel();
  gs2Render();
}

function gs2Render() {
  var typeChecks = Array.from(document.querySelectorAll('#gs2-type-checkboxes input:checked')).map(function(cb){return cb.value;});
  var deptChecks = Array.from(document.querySelectorAll('#gs2-dept-checkboxes input[value]:checked')).map(function(cb){return cb.value;}).filter(Boolean);
  var sort  = document.getElementById('gs2-sort').value;
  var tierOrder = {company:0,department:1,individual:2};

  var filtered = gs2Goals.filter(function(g, idx) {
    g._idx = idx;
    var tier = g.goalTier || inferTier(g);
    if (typeChecks.length > 0 && typeChecks.indexOf(tier) === -1) return false;
    if (deptChecks.length > 0 && deptChecks.indexOf(g.department) === -1) return false;
    return true;
  });

  filtered.sort(function(a,b) {
    if (sort === 'type') {
      var ta = tierOrder[a.goalTier||inferTier(a)]||0, tb = tierOrder[b.goalTier||inferTier(b)]||0;
      return ta !== tb ? ta-tb : (a.department||'') < (b.department||'') ? -1 : 1;
    }
    if (sort === 'dept') return (a.department||'') < (b.department||'') ? -1 : 1;
    if (sort === 'role') return (a.role||'') < (b.role||'') ? -1 : 1;
    if (sort === 'name') return (a.name||'') < (b.name||'') ? -1 : 1;
    if (sort === 'weight-desc') return (parseFloat(b.weight)||0) - (parseFloat(a.weight)||0);
    return 0;
  });

  var empty = document.getElementById('gs2-empty');
  var thead = document.getElementById('gs2-thead');
  var tbody = document.getElementById('gs2-tbody');

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  var tierColors = {company:'#f5e6d3',department:'#d6e8d6',individual:'#d3e4f5'};
  var tierText   = {company:'#7a3010',department:'#1a5c1a',individual:'#0a3d6b'};
  var thS = 'padding:5px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--text-muted);background:var(--surface2);border-bottom:2px solid var(--border);white-space:nowrap;letter-spacing:0.3px;';
  var border = 'border-bottom:1px solid var(--border);';
  var colCtx = 'background:#faf8f5;';
  var colGoal = 'background:#f2f7fa;';
  var colAct = 'background:#f5f8f3;';

  thead.innerHTML = '<tr>' +
    '<th style="'+thS+colCtx+'">Type</th>' +
    '<th style="'+thS+colCtx+'">Location</th>' +
    '<th style="'+thS+colCtx+'">Department</th>' +
    '<th style="'+thS+colCtx+'">Role</th>' +
    '<th style="'+thS+colGoal+'">Goal Name</th>' +
    '<th style="'+thS+colGoal+'">Weight</th>' +
    '<th style="'+thS+colGoal+'">Target</th>' +
    '<th style="'+thS+colGoal+'">Min</th>' +
    '<th style="'+thS+colGoal+'">Lower Better</th>' +
    '<th style="'+thS+colGoal+'">Capped</th>' +
    '<th style="'+thS+colAct+'">Actual</th>' +
    '<th style="'+thS+colAct+'">Achieve%</th>' +
    '<th style="'+thS+'background:#fff;"></th>' +
  '</tr>';

  tbody.innerHTML = filtered.map(function(g) {
    var tier = g.goalTier || inferTier(g);
    var actual = (g.storedActual !== null && g.storedActual !== undefined && g.storedActual !== '') ? g.storedActual : '—';
    var ach = '—';
    if (actual !== '—') {
      var lb = g.lowerBetter !== false;
      ach = (lb ? (parseFloat(g.goalValue)/parseFloat(actual))*100 : (parseFloat(actual)/parseFloat(g.goalValue))*100).toFixed(1) + '%';
    }
    var achColor = actual === '—' ? 'var(--text-muted)' : (parseFloat(ach) >= 100 ? '#2D6B1A' : '#703c2e');
    var td = function(v,bg,x) { return '<td style="padding:5px 6px;'+border+(bg||'')+(x||'')+'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;">'+escAttr(String(v===null||v===undefined?'—':v))+'</td>'; };
    return '<tr data-idx="'+g._idx+'">' +
      '<td style="padding:6px 8px;'+border+colCtx+'">' +
        '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:'+(tierColors[tier]||'#eee')+';color:'+(tierText[tier]||'#333')+';font-weight:700;">' + (tier==='individual'?'Indiv':tier==='department'?'Dept':'Co') + '</span>' +
      '</td>' +
      td(g.location||'—', colCtx) + td(g.department||'—', colCtx) + td(g.role||'—', colCtx) +
      '<td style="padding:8px 10px;'+border+colGoal+'font-weight:600;">'+escAttr(g.name||'')+'</td>' +
      td(g.weight+'%', colGoal) + td(g.goalValue, colGoal) + td(g.minValue, colGoal) +
      td(g.lowerBetter!==false?'Yes':'No', colGoal) +
      td(g.capped==='yes'?'Yes ('+g.capPct+'%)':'No', colGoal) +
      '<td style="padding:8px 10px;'+border+colAct+'font-weight:600;color:'+(actual==='—'?'var(--text-muted)':'var(--text)')+';">'+actual+'</td>' +
      '<td style="padding:8px 10px;'+border+colAct+'font-weight:700;color:'+achColor+';">'+ach+'</td>' +
      '<td style="padding:6px 8px;'+border+'background:#fff;white-space:nowrap;">' +
        '<button onclick="gs2ToggleRowMenu('+g._idx+',this)" style="padding:2px 6px;border:none;background:none;font-size:16px;cursor:pointer;color:var(--text-muted);line-height:1;letter-spacing:1px;" title="Options">&#8942;</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

function gs2InlineRowHTML(g, idx, periods) {
  var tier = g ? (g.goalTier || inferTier(g)) : '';
  var roleOpts = '<option value="">Select role</option>';
  var dept = g ? (g.department || '') : '';
  if (dept && DEPT_ROLES_MAP[dept]) {
    DEPT_ROLES_MAP[dept].forEach(function(r) { roleOpts += '<option value="'+escAttr(r)+'"'+(g && g.role===r?' selected':'')+'>'+escAttr(r)+'</option>'; });
  }
  var periodOpts = periods.map(function(p) { return '<option value="'+escAttr(p)+'"'+(g && g._period===p?' selected':'')+'>'+escAttr(p)+'</option>'; }).join('');

  var sel = function(id, opts, val, onch) {
    return '<select id="'+id+'" onchange="'+(onch||'')+'" style="width:100%;padding:3px 4px;font-size:11px;font-family:var(--sans);border:1.5px solid var(--brick);border-radius:4px;background:#fff;">'
      + opts.replace('value="'+(val||'')+'"', 'value="'+(val||'')+'" selected') + '</select>';
  };
  var inp = function(id, val, type, ph) {
    return '<input id="'+id+'" type="'+(type||'text')+'" value="'+escAttr(String(val||''))+'" placeholder="'+(ph||'')+'" style="width:100%;padding:3px 4px;font-size:11px;font-family:var(--sans);border:1.5px solid var(--brick);border-radius:4px;">';
  };

  var typeOpts = '<option value="">Type</option><option value="company"'+(tier==='company'?' selected':'')+'>Co</option><option value="department"'+(tier==='department'?' selected':'')+'>Dept</option><option value="individual"'+(tier==='individual'?' selected':'')+'>Indiv</option>';
  var locOpts = '<option value="">Loc</option><option value="Utah"'+(g&&g.location==='Utah'?' selected':'')+'>Utah</option><option value="Georgia"'+(g&&g.location==='Georgia'?' selected':'')+'>Georgia</option><option value="Remote"'+(g&&g.location==='Remote'?' selected':'')+'>Remote</option>';
  var deptOpts = '<option value="">Dept</option>'+['Client Care','Design','Experience','Fulfillment','General & Administrative','Growth','Marketing','Operations','Preservation','Recreation','Resin'].map(function(d){ return '<option value="'+escAttr(d)+'"'+(g&&g.department===d?' selected':'')+'>'+escAttr(d)+'</option>'; }).join('');
  var lowerOpts = '<option value="true"'+((!g||g.lowerBetter!==false)?' selected':'')+'>Yes</option><option value="false"'+(g&&g.lowerBetter===false?' selected':'')+'>No</option>';
  var cappedOpts = '<option value="no"'+(!g||g.capped!=='yes'?' selected':'')+'>No</option><option value="yes"'+(g&&g.capped==='yes'?' selected':'')+'>Yes</option>';

  var bgEdit = 'background:#fffbe6;';
  var td = function(inner, extra) { return '<td style="padding:4px 4px;border-bottom:2px solid var(--brick);'+(extra||bgEdit)+'">'+inner+'</td>'; };

  return '<tr id="gs2-inline-row" style="'+bgEdit+'">' +
    td(sel('gs2i-type', typeOpts, tier, 'gs2InlineTypeChange()')) +
    td(sel('gs2i-loc', locOpts, g?g.location:'')) +
    td(sel('gs2i-dept', deptOpts, g?g.department:'', 'gs2InlineDeptChange()')) +
    td(sel('gs2i-role', roleOpts, g?g.role:'')) +
    td(inp('gs2i-name', g?g.name:'', 'text', 'Goal name')) +
    td(inp('gs2i-weight', g?g.weight:'', 'number', '%')) +
    td(inp('gs2i-target', g?g.goalValue:'', 'number', 'Target')) +
    td(inp('gs2i-min', g?g.minValue:'', 'number', 'Min')) +
    td(sel('gs2i-lower', lowerOpts, '')) +
    td(sel('gs2i-capped', cappedOpts, '', 'gs2InlineCappedChange()') + '<input id="gs2i-cappct" type="number" value="'+(g&&g.capped==='yes'?(g.capPct||100):100)+'" style="width:100%;padding:2px 3px;font-size:10px;border:1px solid var(--border);border-radius:3px;margin-top:2px;display:'+(g&&g.capped==='yes'?'block':'none')+';">') +
    td('—', bgEdit+'color:var(--text-muted);font-size:11px;') +
    td('—', bgEdit+'color:var(--text-muted);font-size:11px;') +
    '<td style="padding:4px 6px;border-bottom:2px solid var(--brick);'+bgEdit+'white-space:nowrap;">' +
      '<button onclick="gs2SaveInline()" style="padding:2px 8px;background:var(--brick);color:#fff;border:none;border-radius:4px;font-size:11px;font-family:var(--sans);cursor:pointer;margin-bottom:2px;width:100%;">Save</button>' +
      '<button onclick="gs2CancelInline()" style="padding:2px 8px;background:none;color:var(--text-muted);border:1px solid var(--border);border-radius:4px;font-size:11px;font-family:var(--sans);cursor:pointer;width:100%;">Cancel</button>' +
    '</td>' +
  '</tr>';
}

function gs2InlineTypeChange() {
  var type = document.getElementById('gs2i-type').value;
  var locEl = document.getElementById('gs2i-loc');
  var deptEl = document.getElementById('gs2i-dept');
  var roleEl = document.getElementById('gs2i-role');
  if (locEl) locEl.parentElement.style.opacity = (type==='company') ? '0.3' : '1';
  if (deptEl) deptEl.parentElement.style.opacity = (type==='company') ? '0.3' : '1';
  if (roleEl) roleEl.parentElement.style.opacity = (type!=='individual') ? '0.3' : '1';
}

function gs2InlineDeptChange() {
  var dept = document.getElementById('gs2i-dept').value;
  var roleSelect = document.getElementById('gs2i-role');
  var roles = dept && DEPT_ROLES_MAP[dept] ? DEPT_ROLES_MAP[dept] : [];
  roleSelect.innerHTML = '<option value="">Select role</option>';
  roles.forEach(function(r) { var o=document.createElement('option'); o.value=r; o.textContent=r; roleSelect.appendChild(o); });
}

function gs2InlineCappedChange() {
  var el = document.getElementById('gs2i-cappct');
  if (el) el.style.display = document.getElementById('gs2i-capped').value === 'yes' ? 'block' : 'none';
}

function gs2OpenAdd() {
  gs2EditKey = null;
  gs2ShowInlineRow(null);
}

function gs2OpenEdit(idx) {
  gs2EditKey = idx;
  gs2ShowInlineRow(gs2Goals[idx]);
}

function gs2ShowInlineRow(g) {
  // Remove any existing inline row
  gs2CancelInline(true);
  var q = document.getElementById('gs2-quarter').value;
  var y = document.getElementById('gs2-year').value;
  var m = document.getElementById('gs2-month').value;
  var periods = [];
  if (q && y) {
    periods.push(q + ' ' + y);
    QUARTER_MONTHS_MAP[q].forEach(function(mo) {
      periods.push(new Date(parseInt(y), mo.num, 1).toLocaleString('default', {month:'long',year:'numeric'}));
    });
  }
  var html = gs2InlineRowHTML(g, gs2EditKey, periods);
  var tbody = document.getElementById('gs2-tbody');
  if (gs2EditKey !== null) {
    // Insert after the edited row
    var rows = tbody.querySelectorAll('tr[data-idx="'+gs2EditKey+'"]');
    if (rows.length) {
      rows[0].insertAdjacentHTML('afterend', html);
    } else {
      tbody.insertAdjacentHTML('beforeend', html);
    }
  } else {
    // Add at bottom
    tbody.insertAdjacentHTML('beforeend', html);
  }
  // Scroll into view
  var inlineRow = document.getElementById('gs2-inline-row');
  if (inlineRow) inlineRow.scrollIntoView({behavior:'smooth', block:'nearest'});
}

function gs2CancelInline(silent) {
  var row = document.getElementById('gs2-inline-row');
  if (row) row.remove();
  if (!silent) gs2EditKey = null;
}

function gs2CloseModal() { gs2CancelInline(); }

async function gs2SaveInline() {
  var type    = document.getElementById('gs2i-type') ? document.getElementById('gs2i-type').value : '';
  var loc     = document.getElementById('gs2i-loc') ? document.getElementById('gs2i-loc').value : '';
  var dept    = document.getElementById('gs2i-dept') ? document.getElementById('gs2i-dept').value : '';
  var role    = document.getElementById('gs2i-role') ? document.getElementById('gs2i-role').value : '';
  var name    = document.getElementById('gs2i-name') ? document.getElementById('gs2i-name').value.trim() : '';
  var target  = document.getElementById('gs2i-target') ? document.getElementById('gs2i-target').value : '';
  var min     = document.getElementById('gs2i-min') ? document.getElementById('gs2i-min').value : '';
  var weight  = document.getElementById('gs2i-weight') ? document.getElementById('gs2i-weight').value : '';
  var lower   = document.getElementById('gs2i-lower') ? document.getElementById('gs2i-lower').value === 'true' : true;
  var capped  = document.getElementById('gs2i-capped') ? document.getElementById('gs2i-capped').value : 'no';
  var capPct  = document.getElementById('gs2i-cappct') ? document.getElementById('gs2i-cappct').value : '100';
  var bonusPot = 10;
  var q = document.getElementById('gs2-quarter').value;
  var y = document.getElementById('gs2-year').value;
  var m = document.getElementById('gs2-month').value;
  var period = (gs2EditKey !== null && gs2Goals[gs2EditKey] && gs2Goals[gs2EditKey]._period) ? gs2Goals[gs2EditKey]._period : (m || (q + ' ' + y));

  if (!type)   { showToast('Select a goal type', 'error'); return; }
  if (!period) { showToast('Select a period', 'error'); return; }
  if (!name)   { showToast('Goal name is required', 'error'); return; }
  if (!target) { showToast('Target is required', 'error'); return; }
  if (!min)    { showToast('Minimum is required', 'error'); return; }
  if (!weight) { showToast('Weight is required', 'error'); return; }
  if ((type === 'department' || type === 'individual') && !loc) { showToast('Location is required', 'error'); return; }
  if ((type === 'department' || type === 'individual') && !dept) { showToast('Department is required', 'error'); return; }
  if (type === 'individual' && !role) { showToast('Role is required', 'error'); return; }

  var newGoal = {
    goalTier: type, location: loc, department: dept, role: role,
    name: name, goalValue: parseFloat(target), minValue: parseFloat(min),
    weight: parseFloat(weight), lowerBetter: lower,
    capped: capped, capPct: parseInt(capPct)||100,
    bonusPot: parseFloat(bonusPot)||10,
    storedActual: null, savedAt: new Date().toISOString()
  };

  // Check total weight for individual goals
  if (type === 'individual') {
    var existingGoals = await storageGetGoals(period);
    var sameRole = existingGoals.filter(function(g) {
      return (g.goalTier||inferTier(g)) === 'individual' && g.location === loc && g.department === dept && g.role === role && g.name !== name;
    });
    // If editing, exclude the original
    if (gs2EditKey !== null && gs2Goals[gs2EditKey]) {
      var orig = gs2Goals[gs2EditKey];
      sameRole = sameRole.filter(function(g) { return g.name !== orig.name; });
    }
    var deptGoals = await apiGetGoals({month:period, goalTier:'department', location:loc, department:dept});
    var compGoals = await apiGetGoals({month:period, goalTier:'company'});
    var otherWeight = sameRole.reduce(function(s,g){return s+(parseFloat(g.weight)||0);},0) +
      (deptGoals.goals||[]).reduce(function(s,g){return s+(parseFloat(g.weight)||0);},0) +
      (compGoals.goals||[]).reduce(function(s,g){return s+(parseFloat(g.weight)||0);},0);
    var total = otherWeight + parseFloat(weight);
    if (Math.abs(total - 100) > 0.01) {
      var warn = document.getElementById('gs2-m-weight-warn');
      warn.textContent = 'Total weight for this role would be ' + total.toFixed(0) + '% (must be 100%). Adjust weights to continue.';
      warn.style.display = 'block';
      return;
    }
  }

  // Load, replace/add, save
  var goals = await storageGetGoals(period);
  if (gs2EditKey !== null && gs2Goals[gs2EditKey]) {
    var orig = gs2Goals[gs2EditKey];
    // Remove original from storage
    goals = goals.filter(function(g) {
      return !(g.name === orig.name && (g.goalTier||inferTier(g)) === (orig.goalTier||inferTier(orig)) &&
        g.location === orig.location && g.department === orig.department && g.role === orig.role);
    });
  } else {
    // Check for duplicate name in same tier/loc/dept/role
    goals = goals.filter(function(g) {
      return !(g.name === name && (g.goalTier||inferTier(g)) === type &&
        g.location === loc && g.department === dept && g.role === role);
    });
  }
  goals.push(newGoal);
  await storageSaveGoals(period, goals);

  showToast('Goal saved!', 'success');
  gs2CancelInline(true);
  gs2EditKey = null;
  await gs2Load();
}

async function gs2DeleteGoal(idx) {
  var g = gs2Goals[idx];
  if (!g) return;
  if (!confirm('Delete goal "' + g.name + '"? This cannot be undone.')) return;
  var period = g._period;
  var goals = await storageGetGoals(period);
  goals = goals.filter(function(gl) {
    return !(gl.name === g.name && (gl.goalTier||inferTier(gl)) === (g.goalTier||inferTier(g)) &&
      gl.location === g.location && gl.department === g.department && gl.role === g.role);
  });
  await storageSaveGoals(period, goals);
  showToast('Goal deleted', 'success');
  await gs2Load();
}

// ── Actuals v2 ─────────────────────────────────────────────────
var act2PeriodType = 'monthly';
var act2Scorecards = [];
var act2EditIdx = null;

function act2SetPeriod(type) {
  act2PeriodType = type;
  document.getElementById('act2-period-monthly').className = 'period-btn' + (type==='monthly'?' active':'');
  document.getElementById('act2-period-quarterly').className = 'period-btn' + (type==='quarterly'?' active':'');
  document.getElementById('act2-monthly-field').style.display = type==='monthly' ? '' : 'none';
  document.getElementById('act2-quarterly-field').style.display = type==='quarterly' ? '' : 'none';
  act2Load();
}

function act2GetPeriodLabel() {
  if (act2PeriodType === 'quarterly') {
    var q = document.getElementById('act2-quarter').value;
    var y = document.getElementById('act2-year').value;
    return (q && y) ? q + ' ' + y : '';
  }
  var m = document.getElementById('act2-month').value;
  return m ? formatMonthLabel(m) : '';
}

async function act2Load() {
  var period = act2GetPeriodLabel();
  var loc    = document.getElementById('act2-location').value;
  var dept   = document.getElementById('act2-dept').value;
  var tableSection = document.getElementById('act2-table-section');
  var emptyFilter  = document.getElementById('act2-empty-filter');

  if (!period) {
    tableSection.style.display = 'none';
    emptyFilter.style.display = 'block';
    return;
  }
  emptyFilter.style.display = 'none';
  tableSection.style.display = 'block';

  var all = await storageGetScorecards(period);
  act2Scorecards = all.filter(function(s) {
    if (loc && s.location !== loc) return false;
    if (dept && s.department !== dept) return false;
    return true;
  });

  act2Scorecards.sort(function(a,b) {
    if ((a.department||'') !== (b.department||'')) return (a.department||'') < (b.department||'') ? -1 : 1;
    return (a.employeeName||'') < (b.employeeName||'') ? -1 : 1;
  });

  var title = document.getElementById('act2-table-title');
  title.textContent = 'Scorecards' + (act2Scorecards.length ? ' (' + act2Scorecards.length + ')' : '');

  act2Render();
}

function act2Render() {
  var thead = document.getElementById('act2-thead');
  var tbody = document.getElementById('act2-tbody');
  var empty = document.getElementById('act2-empty');

  var thS = 'padding:5px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--text-muted);background:var(--surface2);border-bottom:2px solid var(--border);white-space:nowrap;';
  thead.innerHTML = '<tr>' +
    '<th style="'+thS+'">Name</th><th style="'+thS+'">Role</th>' +
    '<th style="'+thS+'">Department</th><th style="'+thS+'">Location</th>' +
    '<th style="'+thS+'">Pay Type</th><th style="'+thS+'">Base Earnings</th>' +
    '<th style="'+thS+'">Bonus</th><th style="'+thS+'">Achieve%</th>' +
    '<th style="'+thS+'">Status</th><th style="'+thS+'"></th>' +
  '</tr>';

  if (act2Scorecards.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  var border = 'border-bottom:1px solid var(--border);';
  var td = function(v, x) { return '<td style="padding:5px 6px;'+border+(x||'')+'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;">'+escAttr(String(v===null||v===undefined?'—':v))+'</td>'; };

  tbody.innerHTML = act2Scorecards.map(function(sc, idx) {
    var capped = sc.scorecardCapped ? '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:#FFF8E1;color:#8C5A00;font-weight:600;">Capped</span>' : '';
    var high   = (!sc.scorecardCapped && parseFloat(sc.weightedAchievement||0) >= 120) ? '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:#d6e8d6;color:#1a5c1a;font-weight:600;">120%+</span>' : '';
    var status = capped || high || '—';
    var achColor = parseFloat(sc.weightedAchievement||0) >= 100 ? 'color:#2D6B1A;font-weight:700;' : 'color:#703c2e;font-weight:700;';
    return '<tr data-idx="'+idx+'">' +
      td(sc.employeeName||'') +
      td(sc.role||'') +
      td(sc.department||'') +
      td(sc.location||'') +
      td(sc.payType==='salary'?'Salary':'Hourly') +
      td('$'+(parseFloat(sc.baseEarnings||0).toFixed(0))) +
      td('$'+(parseFloat(sc.bonusAmount||0).toFixed(2)), 'font-weight:600;') +
      td((parseFloat(sc.weightedAchievement||0).toFixed(1))+'%', achColor) +
      '<td style="padding:5px 6px;'+border+'">'+status+'</td>' +
      '<td style="padding:5px 6px;'+border+'">' +
        '<button onclick="act2ToggleRowMenu('+idx+',this)" style="padding:2px 4px;border:none;background:none;font-size:14px;cursor:pointer;color:var(--text-muted);line-height:1;letter-spacing:1px;">&#8942;</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

// ── Actuals inline row ──────────────────────────────────────────
function act2OpenAdd() {
  act2EditIdx = null;
  act2ShowInlineRow(null);
}

function act2OpenEdit(idx) {
  act2EditIdx = idx;
  act2ShowInlineRow(act2Scorecards[idx]);
}

async function act2ShowInlineRow(sc) {
  act2CancelInline(true);
  var period = act2GetPeriodLabel();
  var tbody = document.getElementById('act2-tbody');

  // Build the inline row HTML
  var nameVal = sc ? sc.employeeName||'' : '';
  var roleVal = sc ? sc.role||'' : '';
  var locVal  = sc ? sc.location||'' : (document.getElementById('act2-location').value||'');
  var deptVal = sc ? sc.department||'' : (document.getElementById('act2-dept').value||'');
  var payType = sc ? sc.payType||'hourly' : 'hourly';
  var rate    = sc ? sc.hourlyRate||sc.annualPay||'' : '';
  var hours   = sc ? sc.hours||'' : '';
  var earnings = sc ? sc.baseEarnings||'' : '';
  var manager = sc ? sc.manager||'' : '';

  var bg = 'background:#fffbe6;';
  var inputS = 'width:100%;padding:3px 4px;font-size:11px;font-family:var(--sans);border:1.5px solid var(--brick);border-radius:4px;';
  var labelS = 'font-size:9px;color:var(--text-muted);font-family:var(--mono);display:block;margin-bottom:2px;';

  // For edit mode, load goals
  var goalsHTML = '';
  if (sc && sc.goals && sc.goals.length > 0) {
    goalsHTML = sc.goals.map(function(g, gi) {
      var tier = g.goalTier || 'individual';
      var locked = tier !== 'individual';
      var tierBadge = tier === 'company' ? '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:#f5e6d3;color:#7a3010;font-weight:600;">Co</span>' :
                      tier === 'department' ? '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:#d6e8d6;color:#1a5c1a;font-weight:600;">Dept</span>' :
                      '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:#d3e4f5;color:#0a3d6b;font-weight:600;">Indiv</span>';
      return '<tr style="background:'+(locked?'#f5f5f0':'#fffff0')+';border-bottom:1px solid var(--border);">' +
        '<td style="padding:4px 6px;padding-left:20px;font-size:11px;color:var(--text-muted);">'+tierBadge+'</td>' +
        '<td style="padding:4px 6px;font-size:11px;font-weight:600;">'+escAttr(g.name||'')+'</td>' +
        '<td style="padding:4px 6px;font-size:11px;color:var(--text-muted);">'+g.weight+'%</td>' +
        '<td style="padding:4px 6px;font-size:11px;color:var(--text-muted);">Target: '+g.goalValue+'</td>' +
        '<td style="padding:4px 6px;" colspan="4">' +
          (locked
            ? '<span style="font-size:11px;color:var(--text-muted);">'+(g.actualValue!==undefined&&g.actualValue!==null?g.actualValue:'Enter in Dept/Company tab')+'</span>'
            : '<input type="number" step="any" id="act2-actual-'+gi+'" value="'+escAttr(String(g.actualValue!==undefined&&g.actualValue!==null?g.actualValue:''))+'" placeholder="Enter actual" style="'+inputS+'width:100px;">') +
        '</td>' +
        '<td style="padding:4px 6px;font-size:11px;font-weight:700;color:'+(parseFloat(g.achievement||0)>=100?'#2D6B1A':'#703c2e')+';">'+(g.achievement?parseFloat(g.achievement).toFixed(1)+'%':'—')+'</td>' +
        '<td></td>' +
      '</tr>';
    }).join('');
  }

  var locOpts = '<option value="">Location</option><option value="Utah"'+(locVal==='Utah'?' selected':'')+'>Utah</option><option value="Georgia"'+(locVal==='Georgia'?' selected':'')+'>Georgia</option><option value="Remote"'+(locVal==='Remote'?' selected':'')+'>Remote</option>';
  var payOpts = '<option value="hourly"'+(payType==='hourly'?' selected':'')+'>Hourly</option><option value="salary"'+(payType==='salary'?' selected':'')+'>Salary</option>';

  var rowHTML = '<tr id="act2-inline-row" style="'+bg+'">' +
    '<td style="padding:6px 6px;border-bottom:2px solid var(--brick);'+bg+'" colspan="10">' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:10px;">' +
        '<div><span style="'+labelS+'">Employee name</span>' +
          '<div style="position:relative;">' +
            '<input type="text" id="act2i-name" value="'+escAttr(nameVal)+'" placeholder="Start typing..." autocomplete="off" oninput="act2Typeahead(this.value)" style="'+inputS+'">' +
            '<div id="act2-suggestions" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--surface);border:1.5px solid var(--brick);border-top:none;border-radius:0 0 var(--radius-sm) var(--radius-sm);z-index:200;max-height:180px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.1);"></div>' +
          '</div>' +
        '</div>' +
        '<div><span style="'+labelS+'">Role</span><input type="text" id="act2i-role" value="'+escAttr(roleVal)+'" placeholder="Role" style="'+inputS+'" readonly></div>' +
        '<div><span style="'+labelS+'">Location</span><select id="act2i-loc" style="'+inputS+'">'+locOpts+'</select></div>' +
        '<div><span style="'+labelS+'">Manager</span><input type="text" id="act2i-manager" value="'+escAttr(manager)+'" placeholder="Manager name" style="'+inputS+'"></div>' +
        '<div><span style="'+labelS+'">Pay type</span><select id="act2i-paytype" onchange="act2InlinePayChange()" style="'+inputS+'">'+payOpts+'</select></div>' +
        '<div id="act2i-rate-wrap"><span style="'+labelS+'" id="act2i-rate-label">'+(payType==='salary'?'Annual salary ($)':'Hourly rate ($)')+'</span><input type="number" step="any" id="act2i-rate" value="'+escAttr(String(rate))+'" placeholder="0.00" style="'+inputS+'" oninput="act2CalcEarnings()"></div>' +
        '<div id="act2i-hours-wrap" style="'+(payType==='salary'?'display:none;':'')+'"><span style="'+labelS+'">Hours worked</span><input type="number" step="any" id="act2i-hours" value="'+escAttr(String(hours))+'" placeholder="0" style="'+inputS+'" oninput="act2CalcEarnings()"></div>' +
        '<div><span style="'+labelS+'">Base earnings ($)</span><input type="number" step="any" id="act2i-earnings" value="'+escAttr(String(earnings))+'" placeholder="0.00" style="'+inputS+'"></div>' +
      '</div>' +
      (goalsHTML ? '<div style="font-size:10px;font-weight:700;color:var(--text-muted);font-family:var(--mono);margin-bottom:4px;">GOALS &amp; ACTUALS</div><table style="width:100%;border-collapse:collapse;margin-bottom:10px;"><tbody>'+goalsHTML+'</tbody></table>' : '<div id="act2i-goals-placeholder" style="font-size:12px;color:var(--text-muted);padding:8px 0;font-family:var(--mono);">Goals will load when a role is selected.</div>') +
      '<div id="act2i-weight-warn" style="display:none;padding:8px;background:#FFF8E1;border-radius:var(--radius-sm);font-size:12px;color:#8C5A00;margin-bottom:8px;"></div>' +
      '<div style="display:flex;gap:8px;">' +
        '<button onclick="act2SaveInline()" style="padding:8px 20px;background:var(--brick);color:#fff;border:none;border-radius:var(--radius-sm);font-family:var(--sans);font-size:13px;font-weight:600;cursor:pointer;">Submit Scorecard</button>' +
        '<button onclick="act2CancelInline()" style="padding:8px 16px;background:none;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-family:var(--sans);font-size:13px;cursor:pointer;color:var(--text-muted);">Cancel</button>' +
      '</div>' +
    '</td>' +
  '</tr>';

  if (act2EditIdx !== null) {
    var rows = tbody.querySelectorAll('tr[data-idx="'+act2EditIdx+'"]');
    if (rows.length) { rows[0].insertAdjacentHTML('afterend', rowHTML); }
    else { tbody.insertAdjacentHTML('beforeend', rowHTML); }
  } else {
    tbody.insertAdjacentHTML('beforeend', rowHTML);
  }
  document.getElementById('act2-inline-row').scrollIntoView({behavior:'smooth',block:'nearest'});
}

function act2InlinePayChange() {
  var type = document.getElementById('act2i-paytype').value;
  var hoursWrap = document.getElementById('act2i-hours-wrap');
  var rateLabel = document.getElementById('act2i-rate-label');
  if (hoursWrap) hoursWrap.style.display = type === 'salary' ? 'none' : '';
  if (rateLabel) rateLabel.textContent = type === 'salary' ? 'Annual salary ($)' : 'Hourly rate ($)';
  act2CalcEarnings();
}

function act2CalcEarnings() {
  var type = document.getElementById('act2i-paytype') ? document.getElementById('act2i-paytype').value : 'hourly';
  var rate = parseFloat(document.getElementById('act2i-rate') ? document.getElementById('act2i-rate').value : 0) || 0;
  var earningsEl = document.getElementById('act2i-earnings');
  if (!earningsEl) return;
  if (type === 'salary') {
    earningsEl.value = (rate / 12).toFixed(2);
  } else {
    var hours = parseFloat(document.getElementById('act2i-hours') ? document.getElementById('act2i-hours').value : 0) || 0;
    earningsEl.value = (rate * hours).toFixed(2);
  }
}

async function act2Typeahead(query) {
  var suggestions = document.getElementById('act2-suggestions');
  if (!suggestions) return;
  if (!query || query.length < 2) { suggestions.style.display = 'none'; return; }
  var period = act2GetPeriodLabel();
  var employees = period ? await getRipplingEmployees(period) : [];
  if (!employees.length) {
    var now = new Date();
    employees = await getRipplingEmployees(new Date(now.getFullYear(), now.getMonth(), 1).toLocaleString('default', {month:'long',year:'numeric'}));
  }
  if (!employees.length) {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('rippling:') === 0) {
        try { var d = JSON.parse(localStorage.getItem(k)); if (d&&d.length) { employees = d; break; } } catch(e2) {}
      }
    }
  }
  var q = query.toLowerCase();
  var matches = employees.filter(function(e) { return e.name && e.name.toLowerCase().indexOf(q) !== -1; }).slice(0, 8);
  if (!matches.length) { suggestions.style.display = 'none'; return; }
  suggestions.style.display = 'block';
  suggestions.innerHTML = matches.map(function(e) {
    var pay = e.payType==='salary' ? '$'+parseFloat(e.annualPay||0).toLocaleString()+'/yr' : '$'+(e.hourlyRate||0)+'/hr';
    var eJson = JSON.stringify(e).replace(/"/g,'&quot;');
    return '<div onclick="act2SelectEmployee(JSON.parse(this.dataset.emp))" data-emp="'+eJson+'" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);">' +
      '<div style="font-size:13px;font-weight:600;color:var(--text);">'+escAttr(e.name)+'</div>' +
      '<div style="font-size:11px;color:var(--text-muted);font-family:var(--mono);">'+escAttr(e.role||'')+'&middot;'+escAttr(e.department||'')+'&middot;'+pay+'</div>' +
    '</div>';
  }).join('');
}

async function act2SelectEmployee(e) {
  var sug = document.getElementById('act2-suggestions');
  if (sug) sug.style.display = 'none';
  var nameEl = document.getElementById('act2i-name');
  var roleEl = document.getElementById('act2i-role');
  var locEl  = document.getElementById('act2i-loc');
  if (nameEl) nameEl.value = e.name;
  if (roleEl) roleEl.value = e.role || '';
  if (locEl && e.location) locEl.value = e.location;
  // Set pay type and rate
  var payEl = document.getElementById('act2i-paytype');
  var rateEl = document.getElementById('act2i-rate');
  if (payEl) { payEl.value = e.payType || 'hourly'; act2InlinePayChange(); }
  if (rateEl) { rateEl.value = e.payType==='salary' ? (e.annualPay||'') : (e.hourlyRate||''); act2CalcEarnings(); }
  // Load goals
  await act2LoadGoalsInline(e.role, e.location, e.department || document.getElementById('act2-dept').value);
}

async function act2LoadGoalsInline(role, loc, dept) {
  var period = act2GetPeriodLabel();
  if (!role || !period) return;
  var placeholder = document.getElementById('act2i-goals-placeholder');
  if (placeholder) placeholder.textContent = 'Loading goals...';

  var results = await Promise.all([
    apiGetGoals({month:period, goalTier:'individual', location:loc, department:dept, role:role}),
    apiGetGoals({month:period, goalTier:'department', location:loc, department:dept}),
    apiGetGoals({month:period, goalTier:'company'})
  ]);

  var allGoals = [];
  results.forEach(function(r) { if (r && r.goals) r.goals.forEach(function(g) { allGoals.push(g); }); });

  if (!allGoals.length) {
    if (placeholder) placeholder.textContent = 'No goals found for this role and period.';
    return;
  }

  var inputS = 'width:100px;padding:3px 4px;font-size:11px;font-family:var(--sans);border:1.5px solid var(--brick);border-radius:4px;';
  var goalsHTML = allGoals.map(function(g, gi) {
    var tier = g.goalTier || 'individual';
    var locked = tier !== 'individual';
    var tierBadge = tier==='company' ? '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:#f5e6d3;color:#7a3010;font-weight:600;">Co</span>' :
                    tier==='department' ? '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:#d6e8d6;color:#1a5c1a;font-weight:600;">Dept</span>' :
                    '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:#d3e4f5;color:#0a3d6b;font-weight:600;">Indiv</span>';
    var storedActual = g.storedActual !== null && g.storedActual !== undefined ? g.storedActual : '';
    return '<tr style="background:'+(locked?'#f5f5f0':'#fffff0')+';border-bottom:1px solid var(--border);">' +
      '<td style="padding:4px 6px;padding-left:20px;">'+tierBadge+'</td>' +
      '<td style="padding:4px 6px;font-size:11px;font-weight:600;">'+escAttr(g.name||'')+'</td>' +
      '<td style="padding:4px 6px;font-size:11px;color:var(--text-muted);">'+g.weight+'%</td>' +
      '<td style="padding:4px 6px;font-size:11px;color:var(--text-muted);">Target: '+g.goalValue+'</td>' +
      '<td style="padding:4px 6px;" colspan="4">' +
        (locked
          ? '<span style="font-size:11px;color:var(--text-muted);">'+(storedActual!==''?storedActual:'Enter in Dept/Company tab')+'</span>'
          : '<input type="number" step="any" id="act2-actual-'+gi+'" data-name="'+escAttr(g.name)+'" data-goal="'+g.goalValue+'" data-min="'+g.minValue+'" data-weight="'+g.weight+'" data-lower="'+(g.lowerBetter!==false)+'" data-capped="'+(g.capped||'no')+'" data-cappct="'+(g.capPct||100)+'" data-tier="'+tier+'" placeholder="Actual" style="'+inputS+'" value="'+escAttr(String(storedActual))+'">') +
      '</td>' +
      '<td style="padding:4px 6px;font-size:11px;color:var(--text-muted);">—</td>' +
      '<td></td>' +
    '</tr>';
  }).join('');

  var placeholder2 = document.getElementById('act2i-goals-placeholder');
  if (placeholder2) {
    placeholder2.outerHTML = '<div style="font-size:10px;font-weight:700;color:var(--text-muted);font-family:var(--mono);margin-bottom:4px;">GOALS &amp; ACTUALS</div><table id="act2i-goals-table" style="width:100%;border-collapse:collapse;margin-bottom:10px;"><tbody>'+goalsHTML+'</tbody></table>';
  }
}

async function act2SaveInline() {
  var name     = document.getElementById('act2i-name') ? document.getElementById('act2i-name').value.trim() : '';
  var role     = document.getElementById('act2i-role') ? document.getElementById('act2i-role').value.trim() : '';
  var loc      = document.getElementById('act2i-loc') ? document.getElementById('act2i-loc').value : '';
  var dept     = document.getElementById('act2-dept').value;
  var manager  = document.getElementById('act2i-manager') ? document.getElementById('act2i-manager').value.trim() : '';
  var payType  = document.getElementById('act2i-paytype') ? document.getElementById('act2i-paytype').value : 'hourly';
  var rate     = parseFloat(document.getElementById('act2i-rate') ? document.getElementById('act2i-rate').value : 0) || 0;
  var hours    = parseFloat(document.getElementById('act2i-hours') ? document.getElementById('act2i-hours').value : 0) || 0;
  var earnings = parseFloat(document.getElementById('act2i-earnings') ? document.getElementById('act2i-earnings').value : 0) || 0;
  var period   = act2GetPeriodLabel();

  if (!name)     { showToast('Employee name is required', 'error'); return; }
  if (!period)   { showToast('Select a period first', 'error'); return; }
  if (!earnings) { showToast('Base earnings required', 'error'); return; }

  // Collect goal actuals
  var goalInputs = document.querySelectorAll('#act2-inline-row input[data-name]');
  var goals = [];
  var allFilled = true;
  goalInputs.forEach(function(inp) {
    if (!inp.value && !inp.readOnly) allFilled = false;
    var actual = parseFloat(inp.value) || null;
    var goalVal = parseFloat(inp.dataset.goal);
    var lb = inp.dataset.lower === 'true';
    var ach = (actual && goalVal) ? (lb ? (goalVal/actual)*100 : (actual/goalVal)*100) : 0;
    if (inp.dataset.capped === 'yes') ach = Math.min(ach, parseFloat(inp.dataset.cappct)||100);
    goals.push({
      name: inp.dataset.name, weight: parseFloat(inp.dataset.weight)||0,
      goalValue: goalVal, minValue: parseFloat(inp.dataset.min),
      actualValue: actual, lowerBetter: lb,
      capped: inp.dataset.capped, capPct: parseFloat(inp.dataset.cappct)||100,
      goalTier: inp.dataset.tier, achievement: ach,
      bonusContribution: earnings * (ach/100) * ((parseFloat(inp.dataset.weight)||0)/100) * 0.1
    });
  });

  if (!allFilled) { showToast('Please fill in all individual goal actuals', 'error'); return; }

  // Calculate bonus
  var bonusPot = 10;
  var totalWeighted = goals.reduce(function(s,g) { return s + (g.achievement/100)*(g.weight); }, 0);
  var SCORECARD_CAP = 200;
  var capped = totalWeighted > SCORECARD_CAP;
  var weightedAch = capped ? SCORECARD_CAP : totalWeighted;
  var bonusAmount = parseFloat((earnings * (weightedAch/100) * (bonusPot/100)).toFixed(2));

  var payload = {
    employeeName: name, role: role, department: dept, location: loc,
    manager: manager, payType: payType, hourlyRate: rate, hours: hours,
    baseEarnings: earnings, bonusPotentialPct: bonusPot,
    scorecardMonth: period, weightedAchievement: weightedAch,
    bonusAmount: bonusAmount, scorecardCapped: capped, goals: goals,
    submittedAt: new Date().toISOString()
  };

  await apiSaveScorecard(payload);
  showToast('Scorecard submitted!', 'success');
  act2CancelInline(true);
  act2EditIdx = null;
  await act2Load();
}

function act2CancelInline(silent) {
  var row = document.getElementById('act2-inline-row');
  if (row) row.remove();
  if (!silent) act2EditIdx = null;
}

// ── Row menu ───────────────────────────────────────────────────
var _act2ActiveMenuIdx = null;
function act2ToggleRowMenu(idx, btn) {
  event.stopPropagation();
  var menu = document.getElementById('gs2-row-menu');
  if (_act2ActiveMenuIdx === idx && menu.style.display !== 'none') {
    menu.style.display = 'none'; _act2ActiveMenuIdx = null; return;
  }
  _act2ActiveMenuIdx = idx;
  var rect = btn.getBoundingClientRect();
  menu.style.display = 'block';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = Math.min(rect.right - 130, window.innerWidth - 140) + 'px';
  document.getElementById('gs2-row-menu-edit').onclick = function() { menu.style.display='none'; _act2ActiveMenuIdx=null; act2OpenEdit(idx); };
  document.getElementById('gs2-row-menu-delete').onclick = function() {
    menu.style.display='none'; _act2ActiveMenuIdx=null;
    if (!confirm('Delete this scorecard?')) return;
    act2DeleteScorecard(idx);
  };
}

async function act2DeleteScorecard(idx) {
  var sc = act2Scorecards[idx];
  if (!sc) return;
  var period = act2GetPeriodLabel();
  var all = await storageGetScorecards(period);
  all = all.filter(function(s) { return s.employeeName !== sc.employeeName; });
  await storageSetScorecards(period, all);
  showToast('Scorecard deleted', 'success');
  await act2Load();
}

// ── Goal Bank ───────────────────────────────────────────────────
var bankGoals = []; // all goals in the bank
var bankEditIdx = null;
var bankEditSbId = null;
var BANK_KEY = 'goal-bank-v1';

var bankViewMode = 'goals'; // 'goals' or 'actuals'

function setBankMode(mode) {
  bankViewMode = mode;
  var gBtn = document.getElementById('bank-mode-goals');
  var aBtn = document.getElementById('bank-mode-actuals');
  if (gBtn) { gBtn.style.background = mode==='goals'?'var(--brick)':'none'; gBtn.style.color = mode==='goals'?'#fff':'var(--text-muted)'; gBtn.style.borderColor = mode==='goals'?'var(--brick)':'var(--border)'; }
  if (aBtn) { aBtn.style.background = mode==='actuals'?'var(--brick)':'none'; aBtn.style.color = mode==='actuals'?'#fff':'var(--text-muted)'; aBtn.style.borderColor = mode==='actuals'?'var(--brick)':'var(--border)'; }

  bankRender();
}

function bankResetSaveBar() {
  var saveBtn = document.getElementById('bank-save-btn');
  var saveHint = document.getElementById('bank-save-hint');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.style.background = 'var(--surface2)';
    saveBtn.style.color = 'var(--text-muted)';
    saveBtn.style.borderColor = 'var(--border)';
    saveBtn.style.cursor = 'not-allowed';
  }
  if (saveHint) saveHint.textContent = 'Enter targets or minimums to enable saving';
}

async function bankPopulateMonths() {
  var sel = document.getElementById('bank-month');
  if (!sel) return;
  var now = new Date();
  var currentMonthVal = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  var current = sel.value || currentMonthVal;
  sel.innerHTML = '<option value="">No month selected</option>';
  // Show 6 past months + current + 6 future months
  for (var i = -6; i <= 6; i++) {
    var d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    var val = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    var label = d.toLocaleString('default', {month:'long', year:'numeric'});
    var opt = document.createElement('option');
    opt.value = val; opt.textContent = label;
    if (val === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

function goalMKey(g) {
  var tier = g.goalTier || inferTier(g) || '';
  var role = (tier === 'individual' && g.role) ? ('|' + g.role) : '';
  return g.name + '|' + tier + role;
}

function bankGetMonthTargets(monthVal) {
  if (!monthVal) return {};
  try {
    // Try raw value first (e.g. '2026-04')
    var raw = localStorage.getItem('bank-month-targets:' + monthVal);
    if (raw) return JSON.parse(raw);
    // Try formatted label (e.g. 'April 2026')
    var label = formatMonthLabel(monthVal);
    if (label) {
      var labeled = localStorage.getItem('bank-month-targets:' + label);
      if (labeled) return JSON.parse(labeled);
    }
    return {};
  } catch(e) { return {}; }
}

function bankSaveMonthTargets(monthVal, data) {
  if (!monthVal) return;
  localStorage.setItem('bank-month-targets:' + monthVal, JSON.stringify(data));
}

async function bankLoad() {
  await bankPopulateMonths();
  bankResetSaveBar();
  try {
    if (sb && currentUser) {
      // Load from Supabase
      var data = await sbLoadGoalBank();
      if (data) {
        var allGoals = data.map(function(r) {
          return {
            _sbId: r.id, goalTier: r.goal_tier, location: r.location||'', department: r.department||'',
            role: r.role||'', name: r.name, goalValue: r.goal_value, minValue: r.min_value,
            lowerBetter: r.lower_better, capped: r.capped, capPct: r.cap_pct,
            active: r.active, createdAt: r.created_at
          };
        });
        // Scope to manager's departments/locations if not admin
        if (currentProfile && currentProfile.role !== 'admin') {
          var mgDepts = currentProfile.departments || [];
          var mgLocs  = currentProfile.locations  || [];
          bankGoals = allGoals.filter(function(g) {
            var tier = g.goalTier || inferTier(g);
            if (tier === 'company') return true; // everyone sees company goals
            // Goal matches if dept matches AND (no location set OR location matches)
            var deptOk = mgDepts.length === 0 || !g.department || mgDepts.indexOf(g.department) !== -1;
            var locOk  = mgLocs.length  === 0 || !g.location   || mgLocs.indexOf(g.location)   !== -1;
            return deptOk && locOk;
          });
        } else {
          bankGoals = allGoals;
        }
        // Also cache locally
        localStorage.setItem(BANK_KEY, JSON.stringify(bankGoals));
        actGoals = bankGoals; // keep actuals in sync
        actLoadAllActuals(); // refresh local actuals
        // Also load actuals from Supabase for current month
        var curMonth = document.getElementById('bank-month') ? document.getElementById('bank-month').value : '';
        var curMonthLabel = curMonth ? formatMonthLabel(curMonth) : '';
        if (sb && currentUser && curMonthLabel) {
          sbLoadActuals(curMonthLabel).then(function(sbActs) {
            if (sbActs && Object.keys(sbActs).length) {
              if (!actAllActuals[curMonth]) actAllActuals[curMonth] = {};
              Object.keys(sbActs).forEach(function(k) {
                if (k.indexOf('__target__')!==0 && k.indexOf('__min__')!==0) actAllActuals[curMonth][k] = sbActs[k];
              });
            }
            bankRender();
          });
        } else {
          bankRender();
        }
        var title = document.getElementById('bank-table-title');
        if (title) title.textContent = 'Goal Bank (' + bankGoals.filter(function(g){return g.active!==false;}).length + ' active)';
        return;
      }
    }
    // Fallback to localStorage
    var local = localStorage.getItem(BANK_KEY);
    if (local && local !== '[]' && local !== 'null') {
      bankGoals = JSON.parse(local);
    } else {
      var r = await storageGet(BANK_KEY);
      bankGoals = r ? JSON.parse(r) : [];
    }
  } catch(e) { console.error("bankLoad error:", e); bankGoals = []; }
  bankRender();
  var title = document.getElementById('bank-table-title');
  if (title) title.textContent = 'Goal Bank (' + bankGoals.filter(function(g){return g.active!==false;}).length + ' active)';
}

async function bankSave() {
  var json = JSON.stringify(bankGoals);
  // Always write to localStorage as primary (reliable sync)
  localStorage.setItem(BANK_KEY, json);
  // Also attempt window.storage
  try {
    if (window.storage && typeof window.storage.set === 'function') {
      await window.storage.set(BANK_KEY, json, true);
    }
  } catch(e) {}
}

function bankUpdateTypeLabel() { updateDropdownLabel('bank-type-dd','bank-type-checkboxes','All types'); }
function bankUpdateDeptLabel() { updateDropdownLabel('bank-dept-dd','bank-dept-checkboxes','All departments'); }
function bankToggleAllDepts(cb) {
  document.querySelectorAll('#bank-dept-checkboxes input[value]:not([value=""])').forEach(function(el){el.checked=cb.checked;});
  bankUpdateDeptLabel(); bankRender();
}
function bankResetFilters() {
  document.querySelectorAll('#bank-type-checkboxes input').forEach(function(cb){cb.checked=true;});
  document.querySelectorAll('#bank-dept-checkboxes input').forEach(function(cb){cb.checked=true;});
  document.getElementById('bank-sort').value='type';
  document.getElementById('bank-show-inactive').checked=false;
  var bankLoc = document.getElementById('bank-loc'); if(bankLoc) bankLoc.value='';
  bankUpdateTypeLabel(); bankUpdateDeptLabel(); bankRender();
}

function bankRender() {
  var typeChecks = Array.from(document.querySelectorAll('#bank-type-checkboxes input:checked')).map(function(cb){return cb.value;});
  var deptChecks = Array.from(document.querySelectorAll('#bank-dept-checkboxes input[value]:checked')).map(function(cb){return cb.value;}).filter(Boolean);
  var locF = document.getElementById('bank-loc') ? document.getElementById('bank-loc').value : '';
  var sort = document.getElementById('bank-sort').value;
  var showInactive = document.getElementById('bank-show-inactive').checked;
  var tierOrder = {company:0,department:1,individual:2};

  var filtered = bankGoals.filter(function(g,i){
    g._idx = i;
    if (!showInactive && g.active===false) return false;
    var tier = g.goalTier||inferTier(g);
    if (typeChecks.length>0 && typeChecks.indexOf(tier)===-1) return false;
    // Company goals have no dept — never filter them out by dept
    if (deptChecks.length>0 && g.department && deptChecks.indexOf(g.department)===-1) return false;
    // Location filter — skip for company goals which have no location
    if (locF && g.location && g.location !== locF) return false;
    return true;
  });

  filtered.sort(function(a,b){
    if (sort==='type'){var ta=tierOrder[a.goalTier||inferTier(a)]||0,tb=tierOrder[b.goalTier||inferTier(b)]||0;return ta!==tb?ta-tb:(a.department||'')<(b.department||'')?-1:1;}
    if (sort==='dept') return (a.department||'')<(b.department||'')?-1:1;
    if (sort==='loc') return (a.location||'')<(b.location||'')?-1:1;
    if (sort==='role') return (a.role||'')<(b.role||'')?-1:1;
    if (sort==='name') return (a.name||'')<(b.name||'')?-1:1;
    return 0;
  });

  var thead = document.getElementById('bank-thead');
  var tbody = document.getElementById('bank-tbody');
  var empty = document.getElementById('bank-empty');
  if (!thead||!tbody) return;

  var thS='padding:5px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--text-muted);background:var(--surface2);border-bottom:2px solid var(--border);white-space:nowrap;';
  var colCtx='background:#faf8f5;', colGoal='background:#f2f7fa;';
  var border='border-bottom:1px solid var(--border);';
  var tierColors={company:'#f5e6d3',department:'#d6e8d6',individual:'#d3e4f5'};
  var tierText={company:'#7a3010',department:'#1a5c1a',individual:'#0a3d6b'};

  var monthVal = document.getElementById('bank-month') ? document.getElementById('bank-month').value : '';
  var now = new Date();
  var currentMonthVal = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  // Calculate days since the end of the selected month
  var isPastMonth = false;
  var isEditableWithWarning = false;
  if (monthVal && monthVal < currentMonthVal) {
    var parts = monthVal.split('-');
    var monthEnd = new Date(parseInt(parts[0]), parseInt(parts[1]), 0); // last day of month
    var daysSince = Math.floor((now - monthEnd) / (1000*60*60*24));
    isPastMonth = daysSince > 21;       // hard lock after 21 days
    isEditableWithWarning = !isPastMonth; // editable with warning within 21 days
  }
  var monthTargets = bankGetMonthTargets(monthVal);

  // Update month status label
  var statusEl = document.getElementById('bank-month-status');
  if (statusEl) {
    if (!monthVal) statusEl.textContent = '';
    else if (isPastMonth) statusEl.textContent = '🔒 Past month — locked (21+ days)';
    else if (isEditableWithWarning) statusEl.textContent = '⚠️ Past month — edits allowed for ' + (21 - Math.floor((now - new Date(parseInt(monthVal.split('-')[0]), parseInt(monthVal.split('-')[1]), 0)) / (1000*60*60*24))) + ' more days';
    else if (monthVal === currentMonthVal) statusEl.textContent = '● Current month';
    else statusEl.textContent = '○ Future month';
  }

  // Build colgroup and inject directly into table element
  var tbl = document.getElementById('bank-table');
  if (tbl) {
    var oldCg = tbl.querySelector('colgroup');
    if (oldCg) oldCg.remove();
    var cg = document.createElement('colgroup');
    // Fixed px widths
    var colDefs = ['44px','50px','82px','95px','0','60px','52px'];
    if (monthVal) { colDefs.push('60px'); colDefs.push('56px'); colDefs.push('70px'); } // Target, Min, Actual
    colDefs.push('62px'); colDefs.push('36px');
    // Goal Name gets remaining space (index 4)
    var tblWidth = (document.getElementById('bank-table')||{offsetWidth:900}).offsetWidth || 900;
    var used = colDefs.reduce(function(s,w){ return s + (w==='0'?0:parseInt(w)); }, 0);
    colDefs[4] = Math.max(100, tblWidth - used - 20) + 'px';
    colDefs.forEach(function(w){ var col=document.createElement('col'); col.setAttribute('style','width:'+w); cg.appendChild(col); });
    tbl.insertBefore(cg, tbl.firstChild);
  }

  thead.innerHTML = '<tr>'+
    '<th style="'+thS+colCtx+'">Type</th>'+
    '<th style="'+thS+colCtx+'">Loc</th>'+
    '<th style="'+thS+colCtx+'">Dept</th>'+
    '<th style="'+thS+colCtx+'">Role</th>'+
    '<th style="'+thS+colGoal+'">Goal Name</th>'+
    '<th style="'+thS+colGoal+'">Lower</th>'+
    '<th style="'+thS+colGoal+'">Capped</th>'+
    (monthVal ? '<th style="'+thS+'background:#f5f8f3;">Target</th><th style="'+thS+'background:#f5f8f3;">Min</th>' : '')+
    (monthVal ? '<th style="'+thS+'background:#eef5ec;">Actual</th>' : '')+
    '<th style="'+thS+'background:#fff;">Status</th>'+
    '<th style="'+thS+'background:#fff;width:36px;"></th>'+
  '</tr>';

  if (filtered.length===0){tbody.innerHTML='';empty.style.display='block';return;}
  empty.style.display='none';

  var td=function(v,bg,x){return '<td style="padding:5px 6px;'+border+(bg||'')+(x||'')+'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;">'+escAttr(String(v===null||v===undefined?'—':v))+'</td>';};

  tbody.innerHTML=filtered.map(function(g){
    var tier=g.goalTier||inferTier(g);
    var inactive=g.active===false;
    var rowStyle=inactive?'opacity:0.45;':'';
    var mKey = goalMKey(g);
    var mData = monthTargets[mKey] || {};
    var mTarget = mData.target !== undefined ? mData.target : '';
    var mMin    = mData.min    !== undefined ? mData.min    : '';
    var isEditing = (bankEditIdx === g._idx);
    var canEdit = !isPastMonth;
    var inpStyle = 'width:100%;padding:2px 4px;font-size:11px;font-family:var(--mono);border:1.5px solid '+(canEdit?'var(--brick)':'var(--border)')+';border-radius:3px;background:'+(canEdit?'#fff':'var(--surface2)')+';';

    return '<tr data-idx="'+g._idx+'" style="'+rowStyle+'">'+
      '<td style="padding:5px 6px;'+border+colCtx+'"><span style="font-size:9px;padding:1px 5px;border-radius:99px;background:'+(tierColors[tier]||'#eee')+';color:'+(tierText[tier]||'#333')+';font-weight:700;">'+(tier==='individual'?'Indiv':tier==='department'?'Dept':'Co')+'</span></td>'+
      td(g.location||'—',colCtx)+td(g.department||'—',colCtx)+td(g.role||'—',colCtx)+
      '<td style="padding:5px 6px;'+border+colGoal+'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+escAttr(g.name||'')+'</td>'+
      td(g.lowerBetter!==false?'Yes':'No',colGoal)+
      td(g.capped==='yes'?'Yes ('+g.capPct+'%)':'No',colGoal)+
      (monthVal ?
        '<td style="padding:3px 5px;'+border+'background:#f5f8f3;">'+
          (canEdit && isEditing
            ? '<input type="number" step="any" value="'+escAttr(String(mTarget))+'" data-mkey="'+escAttr(mKey)+'" data-field="target" oninput="bankMonthTargetChange(this)" style="'+inpStyle+'">'
            : '<span style="font-size:11px;color:var(--text);">'+(mTarget!==''?mTarget:'—')+'</span>')+
        '</td>'+
        '<td style="padding:3px 5px;'+border+'background:#f5f8f3;">'+
          (canEdit && isEditing
            ? '<input type="number" step="any" value="'+escAttr(String(mMin))+'" data-mkey="'+escAttr(mKey)+'" data-field="min" oninput="bankMonthTargetChange(this)" style="'+inpStyle+'">'
            : '<span style="font-size:11px;color:var(--text);">'+(mMin!==''?mMin:'—')+'</span>')+
        '</td>'
      : '')+

      (monthVal ? (function(){
        var tier4 = g.goalTier||inferTier(g);
        var actKey4 = [tier4, g.location||'', g.department||'', g.name].join('|');
        var actVal4 = (actAllActuals[monthVal]||{})[actKey4];
        actVal4 = actVal4 !== undefined ? actVal4 : '';
        return '<td style="padding:5px 6px;'+border+'background:#eef5ec;font-size:11px;font-family:var(--mono);">'+(actVal4!==''?actVal4:'—')+'</td>';
      })() : '')+
      '<td style="padding:5px 6px;'+border+'background:#fff;">'+
        '<span style="font-size:9px;padding:1px 6px;border-radius:99px;font-weight:600;background:'+(inactive?'#f0ece6':'#eef5ec')+';color:'+(inactive?'#7a7268':'#1a5c1a')+'">'+(inactive?'Inactive':'Active')+'</span>'+
      '</td>'+
      '<td style="padding:5px 14px 5px 14px;'+border+'background:#fff;text-align:center;">'+
        (bankCanEditGoal(g) ? '<button onclick="bankToggleRowMenu('+g._idx+',this)" style="padding:2px 6px;border:none;background:none;font-size:14px;cursor:pointer;color:var(--text-muted);line-height:1;letter-spacing:1px;">&#8942;</button>' : '')+
      '</td>'+
    '</tr>';
  }).join('');

  var title=document.getElementById('bank-table-title');
  if(title) title.textContent='Goal Bank ('+bankGoals.filter(function(g){return g.active!==false;}).length+' active)';
}

var bankActEditKey = null;
var bankActAllActuals = {}; // month -> key -> value (mirrors actAllActuals)

function bankOpenActualEntry(idx) {
  var g = bankGoals[idx];
  if (!g) return;
  var monthVal = document.getElementById('bank-month') ? document.getElementById('bank-month').value : '';
  if (!monthVal) { showToast('Select a month first', 'error'); return; }
  // Check 21-day rule for past months
  var now = new Date();
  var currentMonthVal = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  if (monthVal < currentMonthVal) {
    var parts = monthVal.split('-');
    var monthEnd = new Date(parseInt(parts[0]), parseInt(parts[1]), 0);
    var daysSince = Math.floor((now - monthEnd) / (1000*60*60*24));
    if (daysSince > 21) { showToast('This month is locked — more than 21 days have passed', 'error'); return; }
    if (!confirm('Warning: Entering actuals for a past month. Continue?')) return;
  }

  // Remove any existing actual entry row
  var existing = document.getElementById('bank-actual-row');
  if (existing) existing.remove();

  var tier = g.goalTier || inferTier(g);
  var actKey = [tier, g.location||'', g.department||'', g.name].join('|');
  var actVal = (actAllActuals[monthVal]||{})[actKey];
  actVal = actVal !== undefined ? actVal : '';
  var mKey = g.name+'|'+tier;
  var mData = bankGetMonthTargets(monthVal)[mKey] || {};
  var tv = mData.target !== undefined ? mData.target : (g.goalValue||'');
  var mv = mData.min    !== undefined ? mData.min    : (g.minValue||'');
  var period = formatMonthLabel(monthVal);

  var bg = 'background:#f0f8f0;';
  var row = document.createElement('tr');
  row.id = 'bank-actual-row';
  row.style.cssText = bg;
  var numCols = document.querySelectorAll('#bank-thead th').length;
  row.innerHTML = '<td colspan="'+numCols+'" style="padding:12px 16px;border-bottom:2px solid var(--brick);'+bg+'">' +
    '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">' +
      '<div style="font-size:12px;font-weight:600;color:var(--text);">'+escAttr(g.name)+'</div>' +
      '<div style="font-size:11px;color:var(--text-muted);font-family:var(--mono);">'+period+' &nbsp;|&nbsp; Target: '+(tv||'—')+' &nbsp;|&nbsp; Min: '+(mv||'—')+'</div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<label style="font-size:11px;font-weight:600;color:var(--text);">Actual:</label>' +
        '<input type="number" step="any" id="bank-actual-inp" value="'+escAttr(String(actVal))+'" placeholder="Enter value" style="width:100px;padding:4px 8px;font-size:12px;font-family:var(--mono);border:1.5px solid var(--brick);border-radius:var(--radius-sm);" autofocus>' +
      '</div>' +
      '<button onclick="bankSaveActual('+idx+')" style="padding:5px 16px;background:var(--brick);color:#fff;border:none;border-radius:var(--radius-sm);font-family:var(--sans);font-size:12px;font-weight:600;cursor:pointer;">Save</button>' +
      '<button onclick="bankCancelActual()" style="padding:5px 12px;border:1.5px solid var(--border);background:none;border-radius:var(--radius-sm);font-family:var(--sans);font-size:12px;cursor:pointer;color:var(--text-muted);">Cancel</button>' +
    '</div>' +
  '</td>';

  // Insert after the goal's row
  var tbody = document.getElementById('bank-tbody');
  var goalRow = tbody ? tbody.querySelector('tr[data-idx="'+idx+'"]') : null;
  if (goalRow) goalRow.insertAdjacentElement('afterend', row);
  else if (tbody) tbody.insertAdjacentElement('afterbegin', row);

  var inp = document.getElementById('bank-actual-inp');
  if (inp) inp.focus();
}

async function bankSaveActual(idx) {
  var g = bankGoals[idx];
  if (!g) return;
  var monthVal = document.getElementById('bank-month') ? document.getElementById('bank-month').value : '';
  var inp = document.getElementById('bank-actual-inp');
  if (!inp || !monthVal) return;
  var val = inp.value !== '' ? parseFloat(inp.value) : null;
  var tier = g.goalTier || inferTier(g);
  var actKey = [tier, g.location||'', g.department||'', g.name].join('|');
  if (!actAllActuals[monthVal]) actAllActuals[monthVal] = {};
  if (val !== null) actAllActuals[monthVal][actKey] = val;
  else delete actAllActuals[monthVal][actKey];
  localStorage.setItem(ACT_ACTUALS_PREFIX + monthVal, JSON.stringify(actAllActuals[monthVal]));
  if (sb && currentUser && val !== null) {
    var period = formatMonthLabel(monthVal) || monthVal;
    await sbSaveActual(period, actKey, val);
  }
  var row = document.getElementById('bank-actual-row');
  if (row) row.remove();
  showToast('Actual saved!', 'success');
}

// ── To Do System ────────────────────────────────────────────

function getTodoTasks() {
  var now = new Date();
  var tasks = [];

  var currentYear  = now.getFullYear();
  var currentMonth = now.getMonth();

  // Next month
  var nextMonth     = currentMonth === 11 ? 0 : currentMonth + 1;
  var nextMonthYear = currentMonth === 11 ? currentYear + 1 : currentYear;
  var nextMonthName = new Date(nextMonthYear, nextMonth, 1).toLocaleString('default', {month:'long', year:'numeric'});
  var nextMonthVal  = nextMonthYear + '-' + String(nextMonth+1).padStart(2,'0');

  // Previous month
  var prevMonth     = currentMonth === 0 ? 11 : currentMonth - 1;
  var prevMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;
  var prevMonthName = new Date(prevMonthYear, prevMonth, 1).toLocaleString('default', {month:'long', year:'numeric'});
  var prevMonthVal  = prevMonthYear + '-' + String(prevMonth+1).padStart(2,'0');

  var isAdmin  = !currentProfile || currentProfile.role === 'admin';
  var mgDepts  = (currentProfile && currentProfile.departments) || [];
  var mgLocs   = (currentProfile && currentProfile.locations)  || [];

  function scopedGoals(tierFilter) {
    return bankGoals.filter(function(g) {
      if (g.active === false) return false;
      var tier = g.goalTier || inferTier(g);
      if (tier === 'individual') return false;
      if (tierFilter && tier !== tierFilter) return false;
      // Company goal targets/actuals: admin only
      if (tier === 'company') return isAdmin;
      // Dept goals: only managers of that specific department AND location
      if (!isAdmin) {
        var dOk = mgDepts.length > 0 && g.department && mgDepts.indexOf(g.department) !== -1;
        var lOk = mgLocs.length === 0 || !g.location || mgLocs.indexOf(g.location) !== -1;
        return dOk && lOk;
      }
      return true;
    });
  }

  // ── RIPPLING UPLOAD TASK (admin only, open 1st, due 7th) ──
  if (isAdmin) {
    var ripUploadDue  = new Date(currentYear, currentMonth, 7);
    var ripUploadOpen = now >= new Date(currentYear, currentMonth, 1);
    var ripUploadLock = new Date(nextMonthYear, nextMonth, 1);
    if (ripUploadOpen && now < ripUploadLock) {
      var currentPeriod = new Date(currentYear, currentMonth, 1).toLocaleString('default', {month:'long', year:'numeric'});
      var ripKey = 'rippling:' + currentPeriod;
      var ripploaded = !!localStorage.getItem(ripKey);
      tasks.push({
        id: 'rippling-' + currentYear + '-' + currentMonth,
        group: 'admin',
        groupLabel: 'Admin Tasks',
        title: 'Upload ' + currentPeriod + ' employee data',
        subtitle: 'Admin · Rippling',
        detail: ripploaded ? 'Uploaded ✓' : 'Not yet uploaded',
        status: ripploaded ? 'complete' : (now > ripUploadDue ? 'overdue' : 'open'),
        due: 'Due ' + ripUploadDue.toLocaleDateString('default', {month:'short', day:'numeric'}),
        daysLeft: ripploaded ? null : Math.ceil((ripUploadDue - now) / (1000*60*60*24)),
        complete: ripploaded,
        isRippling: true,
        monthVal: new Date(currentYear, currentMonth, 1).toLocaleString('default', {month:'long', year:'numeric'})
      });
    }
  }

  // ── TARGET TASKS (open 1st, due 17th, locks 1st of next month) ──
  var targetDue  = new Date(currentYear, currentMonth, 17);
  var targetLock = new Date(nextMonthYear, nextMonth, 1);
  var targetOpen = now >= new Date(currentYear, currentMonth, 1) && now < targetLock;

  if (targetOpen) {
    var targetIsOverdue = now > targetDue;
    var targetDaysLeft  = Math.ceil((targetDue - now) / (1000*60*60*24));
    var targets = bankGetMonthTargets(nextMonthVal);

    scopedGoals().forEach(function(g) {
      var mKey = goalMKey(g);
      var md   = targets[mKey] || {};
      var hasTarget = md.target !== undefined;
      var hasMin    = md.min    !== undefined;
      var complete  = hasTarget && hasMin;
      var tier = g.goalTier || inferTier(g);
      var label = tier === 'company' ? 'Co' : (g.department || 'Dept');
      var missing = !hasTarget && !hasMin ? 'Missing target & minimum' : (!hasTarget ? 'Missing target' : 'Missing minimum');

      tasks.push({
        id: 'target-' + nextMonthVal + '-' + g.name,
        group: 'targets',
        groupLabel: nextMonthName + ' Targets',
        title: g.name,
        subtitle: label + (g.location ? ' · ' + g.location : ''),
        detail: complete ? 'Target: ' + md.target + ' · Min: ' + md.min : missing,
        status: targetLock <= now ? 'locked' : (complete ? 'complete' : (targetIsOverdue ? 'overdue' : 'open')),
        due: 'Due ' + targetDue.toLocaleDateString('default', {month:'short', day:'numeric'}),
        daysLeft: complete ? null : targetDaysLeft,
        complete: complete,
        goalName: g.name,
        goalTier: g.goalTier||inferTier(g),
        monthVal: nextMonthVal,
        action: function() { switchMode('setup'); },
        actionLabel: 'Set in Goals & Actuals'
      });
    });
  }

  // ── ACTUAL TASKS (open 1st, due 14th, locks 21st of current month) ──
  var actualsOpenDate = new Date(currentYear, currentMonth, 1);
  var actualsDue      = new Date(currentYear, currentMonth, 14);
  var actualsLock     = new Date(currentYear, currentMonth, 22);

  if (now >= actualsOpenDate && now < actualsLock) {
    var actualsIsOverdue = now > actualsDue;
    var actualsDaysLeft  = Math.ceil((actualsDue - now) / (1000*60*60*24));
    var prevTargets      = bankGetMonthTargets(prevMonthVal);
    var savedActuals     = actAllActuals[prevMonthVal] || {};

    scopedGoals().forEach(function(g) {
      var mKey2 = goalMKey(g);
      var md2   = prevTargets[mKey2] || {};
      if (md2.target === undefined && md2.min === undefined) return; // skip goals with no targets set
      var tier2  = g.goalTier || inferTier(g);
      var actKey = [tier2, g.location||'', g.department||'', g.name].join('|');
      var actual = savedActuals[actKey];
      var complete2 = actual !== undefined;
      var label2 = tier2 === 'company' ? 'Co' : (g.department || 'Dept');

      var mKeyAct = g.name+'|'+tier2;
      var mdAct = prevTargets[mKeyAct]||{};
      tasks.push({
        id: 'actual-' + prevMonthVal + '-' + g.name,
        group: 'actuals',
        groupLabel: prevMonthName + ' Actuals',
        title: g.name,
        subtitle: label2 + (g.location ? ' · ' + g.location : ''),
        detail: complete2 ? 'Actual: ' + actual : 'No actual entered yet',
        status: complete2 ? 'complete' : (actualsIsOverdue ? 'overdue' : 'open'),
        due: 'Due ' + actualsDue.toLocaleDateString('default', {month:'short', day:'numeric'}),
        daysLeft: complete2 ? null : actualsDaysLeft,
        complete: complete2,
        goalName: g.name,
        goalTier: tier2,
        actKey: actKey,
        monthVal: prevMonthVal,
        target: mdAct.target,
        min: mdAct.min,
        action: function() { switchMode('setup'); },
        actionLabel: 'Enter in Goals & Actuals'
      });
    });
  }

  // ── INDIVIDUAL GOAL ACTUAL TASKS (per employee, merged into actuals group) ──
  if (now >= new Date(currentYear, currentMonth, 1) && now < new Date(currentYear, currentMonth, 22)) {
    var indivIsOverdue2 = now > new Date(currentYear, currentMonth, 14);
    var indivDaysLeft2  = Math.ceil((new Date(currentYear, currentMonth, 14) - now) / (1000*60*60*24));
    var prevPeriod2 = formatMonthLabel(prevMonthVal);

    // Load employees for prev month
    var rKey2 = 'rippling:' + prevPeriod2;
    var rData2 = localStorage.getItem(rKey2);
    var employees2 = rData2 ? JSON.parse(rData2) : [];

    // Scope to manager's depts/locations
    if (!isAdmin) {
      employees2 = employees2.filter(function(e) {
        var dOk = mgDepts.length===0 || !e.department || mgDepts.indexOf(e.department) !== -1;
        var lOk = mgLocs.length===0  || !e.location   || mgLocs.indexOf(e.location) !== -1;
        return dOk && lOk;
      });
    }

    // Get individual goals scoped to manager
    var indivGoals2 = bankGoals.filter(function(g) {
      if (g.active === false) return false;
      var tier = g.goalTier || inferTier(g);
      if (tier !== 'individual') return false;
      if (!isAdmin) {
        var dOk = mgDepts.length===0 || !g.department || mgDepts.indexOf(g.department) !== -1;
        var lOk = mgLocs.length===0  || !g.location   || mgLocs.indexOf(g.location)   !== -1;
        return dOk && lOk;
      }
      return true;
    });

    // One task per employee per matching individual goal
    employees2.forEach(function(emp) {
      var empRole = emp.role || '';
      indivGoals2.filter(function(g){ return !g.role || g.role === empRole; }).forEach(function(g) {
        var tier3 = 'individual';
        // Individual actuals are keyed per employee: use emp location+dept+goal
        var empLoc  = emp.location || '';
        var empDept = emp.department || '';
        var actKey3 = [tier3, empLoc, empDept, g.name, emp.name].join('|');
        var savedActuals3 = actAllActuals[prevMonthVal] || {};
        // Also try the standard key without emp name
        var stdKey = [tier3, empLoc, empDept, g.name].join('|');
        var actual3 = savedActuals3[actKey3] !== undefined ? savedActuals3[actKey3] : savedActuals3[stdKey];
        var complete3 = actual3 !== undefined;

        tasks.push({
          id: 'indiv-' + prevMonthVal + '-' + emp.name + '-' + g.name,
          group: 'actuals',  // merged into actuals group
          groupLabel: prevMonthName + ' Actuals',
          title: emp.name,
          subtitle: (empRole||'') + ' · ' + (g.name||''),
          detail: complete3 ? 'Actual: ' + actual3 : 'No actual entered',
          status: complete3 ? 'complete' : (indivIsOverdue2 ? 'overdue' : 'open'),
          due: 'Due ' + new Date(currentYear, currentMonth, 14).toLocaleDateString('default', {month:'short', day:'numeric'}),
          daysLeft: complete3 ? null : indivDaysLeft2,
          complete: complete3,
          goalName: g.name,
          goalTier: tier3,
          actKey: actKey3,
          altActKey: stdKey,
          monthVal: prevMonthVal,
          isIndivEmployee: true,
          empName: emp.name,
          target: (function(){
            // Try prev month targets first, then current month, then goal default
            var mk=goalMKey(g);
            var md=bankGetMonthTargets(prevMonthVal)[mk]||{};
            if (md.target!==undefined) return md.target;
            var mdCur=bankGetMonthTargets(nextMonthVal)[mk]||{};
            if (mdCur.target!==undefined) return mdCur.target;
            return (g.goalValue!==null&&g.goalValue!==undefined&&!isNaN(g.goalValue))?g.goalValue:null;
          })(),
          min: (function(){
            var mk=goalMKey(g);
            var md=bankGetMonthTargets(prevMonthVal)[mk]||{};
            if (md.min!==undefined) return md.min;
            var mdCur=bankGetMonthTargets(nextMonthVal)[mk]||{};
            if (mdCur.min!==undefined) return mdCur.min;
            return (g.minValue!==null&&g.minValue!==undefined&&!isNaN(g.minValue))?g.minValue:null;
          })()
        });
      });
    });
  }

  return tasks;
}

function renderTodos() {
  var list = document.getElementById('todo-list');
  if (!list) return;

  var tasks = getTodoTasks();
  var openCount = tasks.filter(function(t){ return t.status==='open'||t.status==='overdue'; }).length;

  // Update badge
  var badge = document.getElementById('todo-badge');
  if (badge) { badge.textContent = openCount; badge.style.display = openCount>0?'inline':'none'; }

  if (!tasks.length) {
    list.innerHTML = '<div style="padding:20px;font-size:13px;color:var(--text-muted);font-family:var(--mono);">No tasks right now — check back on the 1st of next month.</div>';
    return;
  }

  var statusColors = {open:'#1a5c1a',overdue:'#9B2C2C',complete:'#525143',locked:'#999'};
  var statusBg     = {open:'#eef5ec',overdue:'#fcebeb',complete:'#f5f5f0',locked:'#f5f5f5'};
  var statusIcon   = {open:'○',overdue:'⚠',complete:'✓',locked:'🔒'};

  // Group by group label
  var groups = {};
  var groupOrder = [];
  tasks.forEach(function(t) {
    if (!groups[t.group]) { groups[t.group] = {label:t.groupLabel, tasks:[], due:t.due}; groupOrder.push(t.group); }
    groups[t.group].tasks.push(t);
  });

  list.innerHTML = groupOrder.map(function(gk) {
    var grp = groups[gk];
    var total = grp.tasks.length;
    var done  = grp.tasks.filter(function(t){return t.complete;}).length;
    var pct   = total ? Math.round((done/total)*100) : 0;
    var allDone = done === total;
    var anyOverdue = grp.tasks.some(function(t){return t.status==='overdue';});
    var headerColor = allDone ? '#2D6B1A' : (anyOverdue ? '#9B2C2C' : 'var(--brick)');
    var showCompletedId = 'show-complete-'+gk;
    var showCompleted = document.getElementById(showCompletedId) ? document.getElementById(showCompletedId).checked : false;
    var visibleTasks = grp.tasks.filter(function(t){ return !t.complete || showCompleted; });

    var rows = visibleTasks.map(function(t) {
      var col = statusColors[t.status]||'#333';
      var ico = statusIcon[t.status]||'○';
      var tid = 'todo-'+t.id.replace(/[^a-zA-Z0-9]/g,'-');
      var rowBg = t.complete ? '' : '';

      if (t.isRippling) {
        return '<div id="'+tid+'" style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">'+
          '<span style="width:18px;text-align:center;font-size:12px;color:'+col+';">'+ico+'</span>'+
          '<div style="flex:1;font-size:12px;font-weight:600;color:var(--text);">'+escAttr(t.title)+'</div>'+
          '<span style="font-size:10px;color:var(--text-muted);font-family:var(--mono);">'+escAttr(t.subtitle)+'</span>'+
          (!t.complete ?
            '<button onclick="todoGoToRippling()" style="padding:3px 10px;border:1.5px solid var(--brick);border-radius:var(--radius-sm);background:none;font-family:var(--sans);font-size:11px;cursor:pointer;color:var(--brick);">Upload Now</button>'
            : '<span style="font-size:10px;color:#2D6B1A;font-family:var(--mono);">✓ uploaded</span>')+
          (!t.complete?'<span style="font-size:10px;color:'+col+';font-family:var(--mono);white-space:nowrap;">'+(t.daysLeft>0?t.daysLeft+'d':'past due')+'</span>':'')+
        '</div>';
      } else if (t.isIndivEmployee) {
        // Individual goal per employee — editable actual input
        var indivActuals = actAllActuals[t.monthVal]||{};
        var iVal = indivActuals[t.actKey]!==undefined ? indivActuals[t.actKey] : '';
        var iTgtInfo = '';
        if (t.target!==undefined&&t.target!==null&&t.target!=='') iTgtInfo += 'Target: '+t.target;
        if (t.min!==undefined&&t.min!==null&&t.min!=='') iTgtInfo += (iTgtInfo?' · ':'')+'Min: '+t.min;
        return '<div id="'+tid+'" style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);'+(t.complete?'opacity:0.6;':'')+'">'+
          '<span style="width:18px;text-align:center;font-size:12px;color:'+col+';">'+ico+'</span>'+
          '<div style="flex:1;min-width:0;">'+
            '<div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+escAttr(t.title)+'</div>'+
            '<div style="font-size:10px;color:var(--text-muted);font-family:var(--mono);">'+escAttr(t.subtitle)+(iTgtInfo?' · '+iTgtInfo:'')+'</div>'+
          '</div>'+
          '<input type="number" step="any" value="'+escAttr(String(iVal))+'" placeholder="Actual" data-todo-id="'+tid+'" data-actkey="'+escAttr(t.actKey)+'" data-monthval="'+escAttr(t.monthVal)+'" onchange="todoSaveActual(this)" style="width:90px;padding:3px 6px;font-size:11px;font-family:var(--mono);border:1.5px solid '+(iVal!==''?'var(--brick)':'var(--border)')+';border-radius:3px;">'+
          (!t.complete?'<span style="font-size:10px;color:'+col+';font-family:var(--mono);white-space:nowrap;">'+(t.daysLeft>0?t.daysLeft+'d':'past due')+'</span>':'<span style="font-size:10px;color:#2D6B1A;font-family:var(--mono);">✓</span>')+
        '</div>';
      } else if (t.group === 'targets') {
        // Show target + min inputs
        var targets = bankGetMonthTargets(t.monthVal);
        var mKey = t.goalName+'|'+t.goalTier;
        var md = targets[mKey]||{};
        var tVal = md.target!==undefined?md.target:'';
        var mVal = md.min!==undefined?md.min:'';
        return '<div id="'+tid+'" style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);'+(t.complete?'opacity:0.5;':'')+'">'+
          '<span style="width:18px;text-align:center;font-size:12px;color:'+col+';">'+ico+'</span>'+
          '<div style="flex:1;font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escAttr(t.title)+'</div>'+
          '<span style="font-size:10px;color:var(--text-muted);font-family:var(--mono);white-space:nowrap;">'+escAttr(t.subtitle)+'</span>'+
          '<input type="number" step="any" value="'+escAttr(String(tVal))+'" placeholder="Target" data-todo-id="'+tid+'" data-field="target" data-mkey="'+escAttr(mKey)+'" data-monthval="'+escAttr(t.monthVal)+'" onchange="todoSaveTarget(this)" style="width:70px;padding:3px 6px;font-size:11px;font-family:var(--mono);border:1.5px solid '+(tVal!==''?'var(--brick)':'var(--border)')+';border-radius:3px;">'+
          '<input type="number" step="any" value="'+escAttr(String(mVal))+'" placeholder="Min" data-todo-id="'+tid+'" data-field="min" data-mkey="'+escAttr(mKey)+'" data-monthval="'+escAttr(t.monthVal)+'" onchange="todoSaveTarget(this)" style="width:70px;padding:3px 6px;font-size:11px;font-family:var(--mono);border:1.5px solid '+(mVal!==''?'var(--brick)':'var(--border)')+';border-radius:3px;">'+
          (!t.complete?'<span style="font-size:10px;color:'+col+';font-family:var(--mono);white-space:nowrap;">'+(t.daysLeft>0?t.daysLeft+'d':'past due')+'</span>':'<span style="font-size:10px;color:#2D6B1A;font-family:var(--mono);">✓</span>')+
        '</div>';
      } else {
        // Actual input — show target and min too
        var savedActuals2 = actAllActuals[t.monthVal]||{};
        var aVal = savedActuals2[t.actKey]!==undefined?savedActuals2[t.actKey]:'';
        var tgtInfo = '';
        if (t.target!==undefined&&t.target!==null&&t.target!=='') tgtInfo += 'Target: '+t.target;
        if (t.min!==undefined&&t.min!==null&&t.min!=='') tgtInfo += (tgtInfo?' · ':'')+'Min: '+t.min;
        return '<div id="'+tid+'" style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);'+(t.complete?'opacity:0.5;':'')+'">'+
          '<span style="width:18px;text-align:center;font-size:12px;color:'+col+';">'+ico+'</span>'+
          '<div style="flex:1;min-width:0;">'+
            '<div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escAttr(t.title)+'</div>'+
            (tgtInfo?'<div style="font-size:10px;color:var(--text-muted);font-family:var(--mono);">'+tgtInfo+'</div>':'')+
          '</div>'+
          '<span style="font-size:10px;color:var(--text-muted);font-family:var(--mono);white-space:nowrap;">'+escAttr(t.subtitle)+'</span>'+
          '<input type="number" step="any" value="'+escAttr(String(aVal))+'" placeholder="Actual" data-todo-id="'+tid+'" data-actkey="'+escAttr(t.actKey)+'" data-monthval="'+escAttr(t.monthVal)+'" onchange="todoSaveActual(this)" style="width:90px;padding:3px 6px;font-size:11px;font-family:var(--mono);border:1.5px solid '+(aVal!==''?'var(--brick)':'var(--border)')+';border-radius:3px;">'+
          (!t.complete?'<span style="font-size:10px;color:'+col+';font-family:var(--mono);white-space:nowrap;">'+(t.daysLeft>0?t.daysLeft+'d':'past due')+'</span>':'<span style="font-size:10px;color:#2D6B1A;font-family:var(--mono);">✓</span>')+
        '</div>';
      }
    }).join('');

    return '<div style="border:1.5px solid var(--border);border-radius:var(--radius);background:var(--surface);overflow:hidden;">'+
      '<div style="padding:14px 18px;border-bottom:1.5px solid var(--border);background:var(--surface2);">'+
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">'+
          '<div style="font-size:13px;font-weight:700;color:var(--text);">'+escAttr(grp.label)+'</div>'+
          '<div style="display:flex;align-items:center;gap:10px;">'+
            '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-muted);cursor:pointer;">'+
              '<input type="checkbox" id="show-complete-'+gk+'" '+(showCompleted?'checked':'')+' onchange="renderTodos()" style="accent-color:var(--brick);">'+
              'Show completed'+
            '</label>'+
            '<span style="font-size:11px;color:var(--text-muted);font-family:var(--mono);">'+done+'/'+total+' done · '+escAttr(grp.due)+'</span>'+
          '</div>'+
        '</div>'+
        '<div style="height:5px;background:var(--border);border-radius:3px;overflow:hidden;">'+
          '<div style="height:100%;width:'+pct+'%;background:'+headerColor+';border-radius:3px;transition:width 0.4s;"></div>'+
        '</div>'+
      '</div>'+
      '<div style="padding:0 18px;">'+(visibleTasks.length ? rows : '<div style="padding:12px 0;font-size:12px;color:var(--text-muted);font-family:var(--mono);">All tasks complete ✓</div>')+'</div>'+
      (!allDone ?
        '<div style="padding:12px 18px;border-top:1px solid var(--border);">'+
          '<button onclick="switchMode(\'setup\')" style="padding:7px 18px;background:var(--brick);color:#fff;border:none;border-radius:var(--radius-sm);font-family:var(--sans);font-size:12px;font-weight:600;cursor:pointer;">Go to Goals & Actuals →</button>'+
        '</div>' : '')+
    '</div>';
  }).join('');
}

// Update todo badge on load - persistent count
function updateTodoBadge() {
  if (!bankGoals.length) return;
  var tasks = getTodoTasks();
  var openCount = tasks.filter(function(t) { return t.status === 'open' || t.status === 'overdue'; }).length;
  var badge = document.getElementById('todo-badge');
  if (badge) { badge.textContent = openCount; badge.style.display = openCount > 0 ? 'inline' : 'none'; }
  // Persist to localStorage so badge shows on reload before data loads
  localStorage.setItem('pf-todo-count', openCount);
}

// Show cached badge count immediately on page load
(function() {
  var cached = localStorage.getItem('pf-todo-count');
  if (cached && parseInt(cached) > 0) {
    // Badge element may not exist yet during early load - will be set by updateTodoBadge
    window._cachedTodoCount = parseInt(cached);
  }
})();

async function todoSaveTarget(inp) {
  var mKey     = inp.dataset.mkey;
  var field    = inp.dataset.field;
  var monthVal = inp.dataset.monthval;
  var val = inp.value !== '' ? parseFloat(inp.value) : undefined;
  if (!monthVal || !mKey) return;
  var targets = bankGetMonthTargets(monthVal);
  if (!targets[mKey]) targets[mKey] = {};
  if (val !== undefined) targets[mKey][field] = val;
  else delete targets[mKey][field];
  bankSaveMonthTargets(monthVal, targets);
  // Save to Supabase
  if (sb && currentUser && val !== undefined) {
    var goalName = mKey.split('|')[0];
    var period = formatMonthLabel(monthVal) || monthVal;
    var sbKey = (field === 'target' ? '__target__' : '__min__') + goalName;
    await sbSaveActual(period, sbKey, val);
  }
  inp.style.borderColor = val !== undefined ? 'var(--brick)' : 'var(--border)';
  showToast('Saved!', 'success');
  // Re-render todos to update status
  setTimeout(renderTodos, 300);
}

async function todoSaveActual(inp) {
  var actKey   = inp.dataset.actkey;
  var monthVal = inp.dataset.monthval;
  var val = inp.value !== '' ? parseFloat(inp.value) : null;
  if (!actKey || !monthVal) return;
  if (!actAllActuals[monthVal]) actAllActuals[monthVal] = {};
  if (val !== null) actAllActuals[monthVal][actKey] = val;
  else delete actAllActuals[monthVal][actKey];
  localStorage.setItem(ACT_ACTUALS_PREFIX + monthVal, JSON.stringify(actAllActuals[monthVal]));
  if (sb && currentUser && val !== null) {
    var period = formatMonthLabel(monthVal) || monthVal;
    await sbSaveActual(period, actKey, val);
  }
  inp.style.borderColor = val !== null ? 'var(--brick)' : 'var(--border)';
  showToast('Saved!', 'success');
  setTimeout(renderTodos, 300);
}

// ── Team Scorecards ─────────────────────────────────────────

// Exclusion list: { 'period': { 'empName|goalName': true, '__all__|goalName': true } }
var SC_EXCLUSIONS_KEY = 'sc-goal-exclusions';
var _scExclusionsCache = {}; // in-memory cache

function getExclusions(period) {
  if (_scExclusionsCache[period]) return _scExclusionsCache[period];
  try {
    var data = JSON.parse(localStorage.getItem(SC_EXCLUSIONS_KEY+':'+period)||'{}');
    _scExclusionsCache[period] = data;
    return data;
  } catch(e) { return {}; }
}

function saveExclusions(period, data) {
  _scExclusionsCache[period] = data; // update cache immediately
  localStorage.setItem(SC_EXCLUSIONS_KEY+':'+period, JSON.stringify(data));
  if (sb && currentUser) {
    sbSaveActual(period, '__exclusions__', JSON.stringify(data)).catch(function(){});
  }
}

function isGoalExcluded(period, empName, goalName) {
  var ex = getExclusions(period);
  return ex['__all__|'+goalName] || ex[empName+'|'+goalName];
}

function deleteGoalFromScorecard(period, empName, goalName) {
  var modal = document.getElementById('sc-delete-modal');
  if (!modal) { console.error('modal not found'); return; }
  document.getElementById('sc-delete-msg').textContent = 'Remove "' + goalName + '" from ' + empName + '\'s scorecard?';
  document.getElementById('sc-delete-single').onclick = function() {
    var ex = getExclusions(period);
    ex[empName+'|'+goalName] = true;
    saveExclusions(period, ex);
    hideSCDeleteModal();
    showToast('Removed from ' + empName + '\'s scorecard', 'success');
    setTimeout(function(){ renderTeamScorecards(); }, 100);
  };
  document.getElementById('sc-delete-all').onclick = function() {
    var ex = getExclusions(period);
    ex['__all__|'+goalName] = true;
    saveExclusions(period, ex);
    hideSCDeleteModal();
    showToast('Removed from all team scorecards for ' + period, 'success');
    setTimeout(function(){ renderTeamScorecards(); }, 100);
  };
  modal.style.display = 'flex';
}

function hideSCDeleteModal() {
  var modal = document.getElementById('sc-delete-modal');
  if (modal) modal.style.display = 'none';
}

async function initTeamScorecards() {
  // Populate month picker from Rippling months
  var sel = document.getElementById('team-sc-month');
  if (!sel) return;
  var months = [];
  try { months = JSON.parse(localStorage.getItem('rippling-months-index')||'[]'); } catch(e) {}
  // Also try Supabase
  if (sb && currentUser) {
    var sbMonths = await sbLoadRipplingPeriods();
    sbMonths.forEach(function(m) { if (months.indexOf(m)===-1) months.push(m); });
  }
  if (!months.length) {
    var now = new Date();
    months = [now.toLocaleString('default',{month:'long',year:'numeric'})];
  }
  var current = sel.value;
  sel.innerHTML = months.map(function(m) {
    return '<option value="'+escAttr(m)+'"'+(m===current?' selected':'')+'>'+escAttr(m)+'</option>';
  }).join('');
  if (!sel.value && months.length) sel.value = months[0];

  // Show dept filter for admins
  var deptFilter = document.getElementById('team-sc-filter-dept');
  var deptSel = document.getElementById('team-sc-dept');
  var isAdmin = !currentProfile || currentProfile.role === 'admin';
  if (deptFilter) deptFilter.style.display = isAdmin ? '' : 'none';
  if (isAdmin && deptSel) {
    var allDepts = ['Client Care','Design','Experience','Fulfillment','General & Administrative','Growth','Marketing','Operations','Preservation','Recreation','Resin'];
    deptSel.innerHTML = '<option value="">All departments</option>' +
      allDepts.map(function(d){ return '<option value="'+d+'">'+d+'</option>'; }).join('');
  }

  renderTeamScorecards();
}

async function renderTeamScorecards() {
  var list = document.getElementById('team-sc-list');
  if (!list) return;
  list.innerHTML = '<div style="padding:20px;font-size:12px;color:var(--text-muted);font-family:var(--mono);">Loading...</div>';

  var period = document.getElementById('team-sc-month') ? document.getElementById('team-sc-month').value : '';
  var deptF  = document.getElementById('team-sc-dept')  ? document.getElementById('team-sc-dept').value  : '';
  if (!period) { list.innerHTML = '<div style="padding:20px;font-size:12px;color:var(--text-muted);">Select a month to view scorecards.</div>'; return; }

  var isAdmin = !currentProfile || currentProfile.role === 'admin';
  var mgDepts = (currentProfile && currentProfile.departments) || [];
  var mgLocs  = (currentProfile && currentProfile.locations)  || [];

  // Load employees for this period
  var employees = await getRipplingEmployees(period);
  if (!employees.length) {
    list.innerHTML = '<div style="padding:20px;font-size:12px;color:var(--text-muted);">No employee data found for '+escAttr(period)+'. Upload Rippling data for this month first.</div>';
    return;
  }

  // Filter by dept
  if (deptF) employees = employees.filter(function(e){ return e.department === deptF; });

  // Load goals, targets, actuals for period
  var rawMonth = '';
  // Convert period label to raw value for bankGetMonthTargets
  var now2 = new Date();
  for (var i=-6;i<=6;i++) {
    var d2 = new Date(now2.getFullYear(), now2.getMonth()+i, 1);
    var label2 = d2.toLocaleString('default',{month:'long',year:'numeric'});
    if (label2 === period) { rawMonth = d2.getFullYear()+'-'+String(d2.getMonth()+1).padStart(2,'0'); break; }
  }
  var monthTargets = rawMonth ? bankGetMonthTargets(rawMonth) : {};
  var savedActuals = rawMonth ? (actAllActuals[rawMonth]||{}) : {};

  // Also load from Supabase
  if (sb && currentUser) {
    var sbActs = await sbLoadActuals(period);
    if (sbActs) {
      Object.keys(sbActs).forEach(function(k) {
        if (k.indexOf('__target__')===0) {
          var gn=k.replace('__target__','');
          bankGoals.forEach(function(g){ if(g.name===gn){ var bk=goalMKey(g); if(!monthTargets[bk])monthTargets[bk]={}; monthTargets[bk].target=sbActs[k]; }});
        } else if (k.indexOf('__min__')===0) {
          var gn2=k.replace('__min__','');
          bankGoals.forEach(function(g){ if(g.name===gn2){ var bk2=goalMKey(g); if(!monthTargets[bk2])monthTargets[bk2]={}; monthTargets[bk2].min=sbActs[k]; }});
        } else {
          savedActuals[k] = sbActs[k];
        }
      });
    }
  }

  // Build scorecard for each employee
  var cards = employees.map(function(emp) {
    var dept = emp.department||'';
    var loc  = normalizeLocation ? normalizeLocation(emp.location||'') : (emp.location||'');
    var role = emp.role||'';

    // Get goals for this employee (excluding deleted ones)
    var ex = getExclusions(period);
    var goals = bankGoals.filter(function(g) {
      if (g.active===false) return false;
      if (ex['__all__|'+g.name] || ex[emp.name+'|'+g.name]) return false;
      var tier = g.goalTier||inferTier(g);
      if (tier==='company') return true;
      if (tier==='department') return (!g.department||g.department===dept) && (!g.location||g.location===loc);
      if (tier==='individual') return (!g.role||g.role===role) && (!g.department||g.department===dept);
      return false;
    }).map(function(g) {
      var tier = g.goalTier||inferTier(g);
      var mKey = g.name+'|'+tier;
      var md   = monthTargets[mKey]||{};
      var target = md.target!==undefined ? md.target : g.goalValue;
      var min    = md.min!==undefined    ? md.min    : g.minValue;
      var actKey = [tier, g.location||'', g.department||'', g.name].join('|');
      var empActKey = [tier, emp.location||'', emp.department||'', g.name, emp.name].join('|');
      // For individual goals, check employee-specific key first (saved from To Do list)
      var actual = savedActuals[empActKey] !== undefined ? savedActuals[empActKey] : savedActuals[actKey];
      var ach = null;
      if (actual!==undefined && actual!==null && target) {
        var lb = g.lowerBetter!==false;
        ach = lb ? (parseFloat(target)/parseFloat(actual))*100 : (parseFloat(actual)/parseFloat(target))*100;
        if (min!==undefined && actual!==null) {
          var metMin = lb ? parseFloat(actual)<=parseFloat(min) : parseFloat(actual)>=parseFloat(min);
          if (!metMin) ach = 0;
        }
        if (g.capped==='yes') ach = Math.min(ach, g.capPct||100);
      }
      return { name:g.name, tier:tier, target:target, min:min, actual:actual, ach:ach, lowerBetter:g.lowerBetter!==false };
    });

    // Calculate weighted achievement — only if ALL goals have targets AND actuals
    var weight = goals.length ? 100/goals.length : 0;
    var allComplete = goals.length > 0 && goals.every(function(g) {
      return g.target !== undefined && g.target !== null &&
             g.actual !== undefined && g.actual !== null;
    });
    var weightedAch = null;
    if (allComplete) {
      var goalsWithAch = goals.filter(function(g){ return g.ach !== null; });
      weightedAch = goalsWithAch.reduce(function(s,g){ return s+g.ach*(weight/100); }, 0);
      weightedAch = Math.min(weightedAch, 200);
    }

    var base = emp.payType==='salary' ? (emp.annualPay/12) : (emp.grossEarnings||0);
    var bonusAmt = allComplete ? base*(weightedAch/100)*0.10 : null;

    return { emp:emp, goals:goals, weightedAch:weightedAch, base:base, bonusAmt:bonusAmt };
  });

  var tierColors={company:'#f5e6d3',department:'#d6e8d6',individual:'#d3e4f5'};
  var tierText={company:'#7a3010',department:'#1a5c1a',individual:'#0a3d6b'};
  var thS='padding:6px 10px;font-size:9px;font-weight:700;color:var(--text-muted);text-align:left;border-bottom:1.5px solid var(--border);white-space:nowrap;background:var(--surface2);';
  var thC='padding:6px 10px;font-size:9px;font-weight:700;color:var(--text-muted);text-align:center;border-bottom:1.5px solid var(--border);white-space:nowrap;background:var(--surface2);';

  list.innerHTML = cards.map(function(sc, scIdx) {
    var emp = sc.emp;
    var achColor = sc.weightedAch===null?'var(--text-muted)':(sc.weightedAch>=100?'#2D6B1A':'#703c2e');
    var achStr = sc.weightedAch===null ? 'Incomplete' : sc.weightedAch.toFixed(1)+'%';
    var weight = sc.goals.length ? (100/sc.goals.length).toFixed(1) : 0;
    var effectiveHourly = (emp.grossEarnings && emp.hoursWorked && emp.hoursWorked > 0 && sc.bonusAmt !== null)
      ? ((emp.grossEarnings + sc.bonusAmt) / emp.hoursWorked).toFixed(2)
      : (emp.grossEarnings && emp.hoursWorked && emp.hoursWorked > 0)
        ? (emp.grossEarnings / emp.hoursWorked).toFixed(2) : null;
    var cardId = 'sc-card-'+scIdx;

    var goalsHtml = sc.goals.map(function(g) {
      var achStr2 = g.ach===null?'—':(g.ach===0?'<span style="color:#9B2C2C;font-weight:700;">Below min</span>':g.ach.toFixed(1)+'%');
      var achCol = g.ach===null?'var(--text-muted)':(g.ach>=100?'#2D6B1A':'#703c2e');
      var tColor = tierColors[g.tier]||'#eee', tText = tierText[g.tier]||'#333';
      var tLabel = g.tier==='company'?'Co':g.tier==='department'?'Dept':'Indiv';
      var bonusContrib = (sc.bonusAmt!==null && g.ach!==null)
        ? '$'+(sc.base*(g.ach/100)*(parseFloat(weight)/100)*0.10).toFixed(2) : '—';
      return '<tr class="sc-goal-row" style="border-bottom:1px solid var(--border);">'+
        '<td style="padding:6px 10px;"><span style="font-size:9px;padding:1px 5px;border-radius:99px;background:'+tColor+';color:'+tText+';font-weight:700;">'+tLabel+'</span></td>'+
        '<td style="padding:6px 10px;font-size:11px;font-weight:600;min-width:140px;">'+escAttr(g.name)+'</td>'+
        '<td style="padding:6px 10px;font-size:11px;font-family:var(--mono);text-align:center;">'+(g.target!==undefined&&g.target!==null?g.target:'—')+'</td>'+
        '<td style="padding:6px 10px;font-size:11px;font-family:var(--mono);text-align:center;">'+(g.min!==undefined&&g.min!==null?g.min:'—')+'</td>'+
        '<td style="padding:6px 10px;font-size:11px;font-family:var(--mono);text-align:center;">'+weight+'%</td>'+
        '<td style="padding:6px 10px;font-size:11px;font-family:var(--mono);text-align:center;">'+(g.actual!==undefined&&g.actual!==null?g.actual:'—')+'</td>'+
        '<td style="padding:6px 10px;font-size:11px;font-family:var(--mono);text-align:center;color:'+achCol+';font-weight:700;">'+achStr2+'</td>'+
        '<td style="padding:6px 10px;font-size:11px;font-family:var(--mono);text-align:center;">'+bonusContrib+'</td>'+
        '<td style="padding:4px 6px;text-align:center;width:28px;">'+
          '<button class="sc-del-btn" data-period="'+escAttr(period)+'" data-emp="'+escAttr(sc.emp.name)+'" data-goal="'+escAttr(g.name)+'" '+
          'onclick="deleteGoalFromScorecard(this.dataset.period,this.dataset.emp,this.dataset.goal)" '+
          'title="Remove goal" style="border:none;background:none;color:#9B2C2C;font-size:14px;cursor:pointer;padding:0;line-height:1;">✕</button>'+
        '</td>'+
      '</tr>';
    }).join('');

    var detailHtml = '<div id="'+cardId+'-detail" style="display:none;">'+
      // Earnings summary row
      '<div style="display:flex;gap:24px;padding:10px 16px;background:var(--surface2);border-top:1px solid var(--border);flex-wrap:wrap;">'+
        '<div><div style="font-size:9px;color:var(--text-muted);font-weight:700;font-family:var(--mono);">MONTHLY EARNINGS</div><div style="font-size:13px;font-weight:700;color:var(--text);">'+(emp.grossEarnings?'$'+emp.grossEarnings.toFixed(2):'—')+'</div></div>'+
        '<div><div style="font-size:9px;color:var(--text-muted);font-weight:700;font-family:var(--mono);">HOURS WORKED</div><div style="font-size:13px;font-weight:700;color:var(--text);">'+(emp.hoursWorked?emp.hoursWorked.toFixed(2):'—')+'</div></div>'+
        (emp.hourlyRate?'<div><div style="font-size:9px;color:var(--text-muted);font-weight:700;font-family:var(--mono);">HOURLY RATE</div><div style="font-size:13px;font-weight:700;color:var(--text);">$'+parseFloat(emp.hourlyRate).toFixed(2)+'</div></div>':'')+
        (effectiveHourly?'<div><div style="font-size:9px;color:var(--text-muted);font-weight:700;font-family:var(--mono);">EFFECTIVE HOURLY</div><div style="font-size:13px;font-weight:700;color:var(--text);">$'+effectiveHourly+'</div></div>':'')+
        '<div><div style="font-size:9px;color:var(--text-muted);font-weight:700;font-family:var(--mono);">BONUS AMOUNT</div><div style="font-size:13px;font-weight:700;color:var(--brick);">'+(sc.bonusAmt!==null?'$'+sc.bonusAmt.toFixed(2):'—')+'</div></div>'+
      '</div>'+
      // Goals table
      '<div style="overflow-x:auto;">'+
      '<table style="width:100%;border-collapse:collapse;font-size:11px;">'+
        '<thead><tr>'+
          '<th style="'+thS+'">Type</th>'+
          '<th style="'+thS+'">Goal</th>'+
          '<th style="'+thC+'">Target</th>'+
          '<th style="'+thC+'">Min</th>'+
          '<th style="'+thC+'">Weight</th>'+
          '<th style="'+thC+'">Actual</th>'+
          '<th style="'+thC+'">Achieve%</th>'+
          '<th style="'+thC+'">Bonus $</th>'+
          '<th style="width:28px;background:var(--surface2);border-bottom:1.5px solid var(--border);"></th>'+
        '</tr></thead>'+
        '<tbody>'+goalsHtml+'</tbody>'+
      '</table>'+
      '</div>'+
    '</div>';

    return '<div style="border:1.5px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--surface);margin-bottom:2px;">'+
      // Summary bar — always visible
      '<div onclick="toggleScorecard(\''+cardId+'\')" style="display:flex;align-items:center;gap:12px;padding:13px 16px;cursor:pointer;background:var(--surface);" onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'var(--surface)\'">'+
        '<div id="'+cardId+'-arrow" style="font-size:12px;color:var(--text-muted);transition:transform 0.2s;flex-shrink:0;">▶</div>'+
        '<div style="flex:1;min-width:0;">'+
          '<div style="font-size:13px;font-weight:700;color:var(--text);">'+escAttr(emp.name)+'</div>'+
          '<div style="font-size:11px;color:var(--text-muted);margin-top:1px;">'+escAttr(emp.role||'')+(emp.department?' · '+escAttr(emp.department):'')+(emp.location?' · '+escAttr(emp.location):'')+'</div>'+
        '</div>'+
        '<div style="text-align:right;flex-shrink:0;">'+
          '<div style="font-size:11px;color:var(--text-muted);font-family:var(--mono);">Achievement</div>'+
          '<div style="font-size:17px;font-weight:700;color:'+achColor+';">'+achStr+'</div>'+
        '</div>'+
        '<div style="text-align:right;flex-shrink:0;min-width:80px;">'+
          '<div style="font-size:11px;color:var(--text-muted);font-family:var(--mono);">Bonus</div>'+
          '<div style="font-size:17px;font-weight:700;color:var(--brick);">'+(sc.bonusAmt!==null?'$'+sc.bonusAmt.toFixed(2):'—')+'</div>'+
        '</div>'+
      '</div>'+
      detailHtml+
    '</div>';
  }).join('');
}

function toggleScorecard(cardId) {
  var detail = document.getElementById(cardId+'-detail');
  var arrow  = document.getElementById(cardId+'-arrow');
  if (!detail) return;
  var open = detail.style.display !== 'none';
  detail.style.display = open ? 'none' : 'block';
  if (arrow) arrow.style.transform = open ? '' : 'rotate(90deg)';
}

async function clearMonthTargets() {
  var monthVal = document.getElementById('bank-month') ? document.getElementById('bank-month').value : '';
  if (!monthVal) { showToast('Select a month first', 'error'); return; }

  // Check if month is locked (more than 21 days past end of month)
  var now = new Date();
  var curMonthVal = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  if (monthVal < curMonthVal) {
    var parts = monthVal.split('-');
    var monthEnd = new Date(parseInt(parts[0]), parseInt(parts[1]), 0);
    var daysSince = Math.floor((now - monthEnd) / (1000*60*60*24));
    if (daysSince > 21) {
      showToast('This month is locked — targets cannot be cleared after 21 days', 'error');
      return;
    }
    if (!confirm('Warning: Clearing targets for a past month affects historical records. Continue?')) return;
  }

  var monthLabel = formatMonthLabel(monthVal);
  if (!confirm('Clear all targets & minimums for ' + monthLabel + '? This cannot be undone.')) return;

  localStorage.removeItem('bank-month-targets:' + monthVal);
  if (sb && currentUser) {
    await sb.from('actuals').delete().eq('period', monthLabel).like('goal_name', '__target__%');
    await sb.from('actuals').delete().eq('period', monthLabel).like('goal_name', '__min__%');
  }
  showToast('Targets & minimums cleared for ' + monthLabel, 'success');
  bankRender();
}

function todoGoToRippling() { switchMode('rippling'); }
function todoGoToScorecard() { switchMode('scorecard'); }
function todoGoToGoals() { switchMode('setup'); }

function bankCancelActual() {
  var row = document.getElementById('bank-actual-row');
  if (row) row.remove();
}

function bankSetActEdit(key) {
  bankActEditKey = bankActEditKey === key ? null : key;
  bankRender();
  if (bankActEditKey) {
    setTimeout(function() {
      var inp = document.querySelector('#bank-tbody input[data-actkey]');
      if (inp) inp.focus();
    }, 50);
  }
}

async function bankActChange(inp) {
  var actKey = inp.dataset.actkey;
  var month  = inp.dataset.actmonth;
  if (!actKey || !month) return;
  var val = inp.value !== '' ? parseFloat(inp.value) : null;
  if (!actAllActuals[month]) actAllActuals[month] = {};
  if (val !== null) actAllActuals[month][actKey] = val;
  else delete actAllActuals[month][actKey];
  // Save to localStorage
  localStorage.setItem(ACT_ACTUALS_PREFIX + month, JSON.stringify(actAllActuals[month]));
  // Save to Supabase
  if (sb && currentUser && val !== null) {
    var period = formatMonthLabel(month) || month;
    await sbSaveActual(period, actKey, val);
  }
  // Show save confirmation
  showToast('Actual saved!', 'success');
  bankActEditKey = null;
  bankRender();
}

function bankMonthTargetChange(inp) {
  var mKey = inp.dataset.mkey;
  var field = inp.dataset.field;
  var monthVal = document.getElementById('bank-month') ? document.getElementById('bank-month').value : '';
  if (!monthVal || !mKey) return;
  var targets = bankGetMonthTargets(monthVal);
  if (!targets[mKey]) targets[mKey] = {};
  var val = inp.value !== '' ? parseFloat(inp.value) : undefined;
  if (val !== undefined) targets[mKey][field] = val;
  else delete targets[mKey][field];
  bankSaveMonthTargets(monthVal, targets);
  // Save to Supabase too
  if (sb && currentUser && val !== undefined) {
    var period = formatMonthLabel(monthVal) || monthVal;
    var sbKey = (field === 'target' ? '__target__' : '__min__') + mKey;
    sbSaveActual(period, sbKey, val);
  }
  // Enable save button
  var saveBtn = document.getElementById('bank-save-btn');
  var saveHint = document.getElementById('bank-save-hint');
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.style.background = 'var(--brick)';
    saveBtn.style.color = '#fff';
    saveBtn.style.borderColor = 'var(--brick)';
    saveBtn.style.cursor = 'pointer';
  }
  if (saveHint) saveHint.textContent = 'You have unsaved changes';
}

function bankSaveMonthTargetsAll() {
  var monthEl = document.getElementById('bank-month');
  if (!monthEl || !monthEl.value) return;
  var label = monthEl.options[monthEl.selectedIndex] ? monthEl.options[monthEl.selectedIndex].text : monthEl.value;
  var saveBtn = document.getElementById('bank-save-btn');
  var saveHint = document.getElementById('bank-save-hint');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.style.background = 'var(--surface2)';
    saveBtn.style.color = 'var(--text-muted)';
    saveBtn.style.borderColor = 'var(--border)';
    saveBtn.style.cursor = 'not-allowed';
  }
  if (saveHint) saveHint.textContent = 'All changes saved';
  showToast('Targets & minimums saved for ' + label, 'success');
}

// ── Bank row menu ───────────────────────────────────────────────
var _bankActiveMenuIdx=null;
function bankCanEditGoal(g) {
  // Admins can edit any goal
  if (!currentProfile || currentProfile.role === 'admin') return true;
  // Managers cannot edit company goals or deactivate
  var tier = g ? (g.goalTier || inferTier(g)) : '';
  if (tier === 'company') return false;
  // Managers can only edit goals in their own departments
  var mgDepts = currentProfile.departments || [];
  return !g.department || mgDepts.indexOf(g.department) !== -1;
}

function bankToggleRowMenu(idx,btn){
  event.stopPropagation();
  var menu=document.getElementById('gs2-row-menu');
  if(_bankActiveMenuIdx===idx&&menu.style.display!=='none'){menu.style.display='none';_bankActiveMenuIdx=null;return;}
  _bankActiveMenuIdx=idx;
  var rect=btn.getBoundingClientRect();
  menu.style.display='block';
  menu.style.top=(rect.bottom+4)+'px';
  menu.style.left=Math.min(rect.right-130,window.innerWidth-140)+'px';
  var g=bankGoals[idx];
  var isInactive=g&&g.active===false;
  var isAdminUser3 = !currentProfile || currentProfile.role === 'admin';
  var tier3 = g ? (g.goalTier||inferTier(g)) : '';
  var isAdminMenu2 = !currentProfile || currentProfile.role === 'admin';
  var bankMonthVal = document.getElementById('bank-month') ? document.getElementById('bank-month').value : '';
  var now3 = new Date();
  var curMonthVal3 = now3.getFullYear() + '-' + String(now3.getMonth()+1).padStart(2,'0');
  // Actuals only for past months (not current or future), not individual goals, company = admin only
  var isPastForActuals = bankMonthVal && bankMonthVal < curMonthVal3;
  var canEnterActuals = isPastForActuals && tier3 !== 'individual' && (tier3 !== 'company' || isAdminMenu2);

  document.getElementById('gs2-row-menu-edit').innerHTML='&#9998;&nbsp; Edit Goal';
  document.getElementById('gs2-row-menu-edit').onclick=function(){menu.style.display='none';_bankActiveMenuIdx=null;bankOpenEdit(idx);};

  // Enter Actuals option
  var existingAct = document.getElementById('gs2-row-menu-actuals');
  if (existingAct) existingAct.remove();
  if (canEnterActuals) {
    var actDiv = document.createElement('div');
    actDiv.id = 'gs2-row-menu-actuals';
    actDiv.innerHTML = '&#10003;&nbsp; Enter Actual';
    actDiv.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;font-size:12px;font-family:var(--sans);color:var(--text);border-radius:4px;';
    actDiv.onmouseover = function(){this.style.background='var(--surface2)';};
    actDiv.onmouseout  = function(){this.style.background='none';};
    actDiv.onclick = function(){
      menu.style.display='none'; _bankActiveMenuIdx=null;
      bankOpenActualEntry(idx);
    };
    document.getElementById('gs2-row-menu-edit').insertAdjacentElement('afterend', actDiv);
  }

  // Deactivate — admin only
  var deactEl = document.getElementById('gs2-row-menu-delete');
  deactEl.style.display = isAdminUser3 ? '' : 'none';
  deactEl.innerHTML=(isInactive?'&#9654;&nbsp; Activate':'&#9646;&#9646;&nbsp; Deactivate');
  deactEl.style.color=isInactive?'#1a5c1a':'var(--text-muted)';
  deactEl.onclick=function(){menu.style.display='none';_bankActiveMenuIdx=null;bankToggleActive(idx);};
  // Delete — admin only
  var existing=document.getElementById('gs2-row-menu-harddelete');
  if(existing) existing.remove();
  if (isAdminUser3) {
    var delDiv=document.createElement('div');
    delDiv.id='gs2-row-menu-harddelete';
    delDiv.innerHTML='&#128465;&nbsp; Delete';
    delDiv.style.cssText='display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;font-size:12px;font-family:var(--sans);color:var(--brick);border-radius:4px;border-top:1px solid var(--border);margin-top:4px;';
    delDiv.onmouseover=function(){this.style.background='var(--surface2)';};
    delDiv.onmouseout=function(){this.style.background='none';};
    delDiv.onclick=function(){menu.style.display='none';_bankActiveMenuIdx=null;bankDelete(idx);};
    menu.appendChild(delDiv);
  }
}

async function bankToggleActive(idx){
  var g = bankGoals[idx];
  var newActive = g.active===false ? true : false;
  if (sb && currentUser && g._sbId) {
    await sbToggleGoalActive(g._sbId, newActive);
  }
  g.active = newActive;
  await bankSave();
  bankRender();
  showToast(newActive?'Goal activated':'Goal deactivated','success');
}

async function bankDelete(idx){
  var g = bankGoals[idx];
  if(!confirm('Permanently delete "'+g.name+'"? This cannot be undone.')) return;
  if (sb && currentUser && g._sbId) {
    await sbDeleteGoal(g._sbId);
  }
  bankGoals.splice(idx,1);
  await bankSave();
  bankRender();
  showToast('Goal deleted','success');
}

// ── Bank inline row ─────────────────────────────────────────────
function bankOpenAdd(){bankEditIdx=null;bankShowInlineRow(null);}
function bankEditDone(){
  bankEditIdx=null;
  bankRender();
}

function bankOpenEdit(idx){
  var g = bankGoals[idx];
  if (!g) return;
  // Check if this is a past month within the 21-day warning window
  var monthVal = document.getElementById('bank-month') ? document.getElementById('bank-month').value : '';
  var now = new Date();
  var currentMonthVal = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  if (monthVal && monthVal < currentMonthVal) {
    var parts = monthVal.split('-');
    var monthEnd = new Date(parseInt(parts[0]), parseInt(parts[1]), 0);
    var daysSince = Math.floor((now - monthEnd) / (1000*60*60*24));
    if (daysSince > 21) {
      showToast('This month is locked — more than 21 days have passed', 'error');
      return;
    }
    if (!confirm('Warning: Editing a past month. Changes affect historical records. Continue?')) return;
  }
  bankCancelInline(true);
  bankEditIdx=idx;
  bankEditSbId = g._sbId || null;
  var tbody = document.getElementById('bank-tbody');
  var targetRow = tbody ? tbody.querySelector('tr[data-idx="'+idx+'"]') : null;
  bankShowInlineRow(g, targetRow);
}

function bankShowInlineRow(g, targetRow){
  bankCancelInline(true);
  var tier=g?g.goalTier||inferTier(g):'';
  var monthVal = document.getElementById('bank-month') ? document.getElementById('bank-month').value : '';
  var monthTargets = bankGetMonthTargets(monthVal);
  var mKey = g ? ((g._sbId || g.name) + '|' + (g.goalTier||'')) : '';
  var mData = mKey ? (monthTargets[mKey] || {}) : {};
  var mTarget = mData.target !== undefined ? mData.target : '';
  var mMin    = mData.min    !== undefined ? mData.min    : '';
  var inputS='width:100%;padding:3px 4px;font-size:11px;font-family:var(--sans);border:1.5px solid var(--brick);border-radius:4px;';
  var labelS='font-size:9px;color:var(--text-muted);font-family:var(--mono);display:block;margin-bottom:2px;';
  var bg='background:#fffbe6;';

  var isAdminUser2 = !currentProfile || currentProfile.role === 'admin';
  var typeOpts='<option value="">Type</option>'+(isAdminUser2?'<option value="company"'+(tier==='company'?' selected':'')+'>Company</option>':'')+
    '<option value="department"'+(tier==='department'?' selected':'')+'>Department</option>'+
    '<option value="individual"'+(tier==='individual'?' selected':'')+'>Individual</option>';
  var locChecks = '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;margin-right:8px;cursor:pointer;"><input type="checkbox" id="banki-loc-ut" value="Utah" '+(g&&g.location==='Utah'||!g?'checked':'')+' style="accent-color:var(--brick);"> Utah</label>'+
    '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;margin-right:8px;cursor:pointer;"><input type="checkbox" id="banki-loc-ga" value="Georgia" '+(g&&g.location==='Georgia'||!g?'checked':'')+' style="accent-color:var(--brick);"> Georgia</label>'+
    '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;"><input type="checkbox" id="banki-loc-re" value="Remote" '+(g&&g.location==='Remote'?'checked':'')+' style="accent-color:var(--brick);"> Remote</label>';
  var allDepts2 = ['Client Care','Design','Experience','Fulfillment','General & Administrative','Growth','Marketing','Operations','Preservation','Recreation','Resin'];
  var allowedDepts2 = (currentProfile && currentProfile.role !== 'admin' && (currentProfile.departments||[]).length)
    ? currentProfile.departments : allDepts2;
  var deptOpts='<option value="">Department</option>'+allowedDepts2.map(function(d){return '<option value="'+escAttr(d)+'"'+(g&&g.department===d?' selected':'')+'>'+escAttr(d)+'</option>';}).join('');
  var lowerOpts='<option value="true"'+(!g||g.lowerBetter!==false?' selected':'')+'>Yes</option><option value="false"'+(g&&g.lowerBetter===false?' selected':'')+'>No</option>';
  var cappedOpts='<option value="no"'+(!g||g.capped!=='yes'?' selected':'')+'>No</option><option value="yes"'+(g&&g.capped==='yes'?' selected':'')+'>Yes</option>';

  var monthVal = document.getElementById('bank-month') ? document.getElementById('bank-month').value : '';
  var colCount = monthVal ? 11 : 9;
  var rowHTML='<tr id="bank-inline-row" style="'+bg+'"><td colspan="'+colCount+'" style="padding:10px 12px;border-bottom:2px solid var(--brick);'+bg+'">'+
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:10px;">'+
      '<div><span style="'+labelS+'">Type</span><select id="banki-type" onchange="bankInlineTypeChange()" style="'+inputS+'">'+typeOpts+'</select></div>'+
      '<div id="banki-loc-wrap"><span style="'+labelS+'">Location</span><div style="display:flex;flex-wrap:wrap;gap:4px;padding:4px 0;">'+locChecks+'</div></div>'+
      '<div id="banki-dept-wrap"><span style="'+labelS+'">Department</span><select id="banki-dept" onchange="bankInlineDeptChange()" style="'+inputS+'">'+deptOpts+'</select></div>'+
      '<div id="banki-role-wrap"><span style="'+labelS+'">Role</span><select id="banki-role" style="'+inputS+'"><option value="">Select role</option></select></div>'+
      '<div style="grid-column:1/-1;"><span style="'+labelS+'">Goal name</span><input type="text" id="banki-name" value="'+escAttr(g?g.name||'':'')+'" placeholder="e.g. Individual Ratio" style="'+inputS+'"></div>'+
      '<div><span style="'+labelS+'">Target</span><input type="number" step="any" id="banki-month-target" value="'+escAttr(String(mTarget))+'" placeholder="e.g. 1.6" style="'+inputS+'"></div>'+
      '<div><span style="'+labelS+'">Minimum</span><input type="number" step="any" id="banki-month-min" value="'+escAttr(String(mMin))+'" placeholder="e.g. 1.2" style="'+inputS+'"></div>'+
      '<div><span style="'+labelS+'">Lower is better?</span><select id="banki-lower" style="'+inputS+'">'+lowerOpts+'</select></div>'+
      '<div><span style="'+labelS+'">Capped?</span><select id="banki-capped" onchange="bankInlineCappedChange()" style="'+inputS+'">'+cappedOpts+'</select></div>'+
      '<div id="banki-cappct-wrap" style="'+(g&&g.capped==='yes'?'':'display:none;')+'"><span style="'+labelS+'">Cap %</span><input type="number" id="banki-cappct" value="'+escAttr(String(g?g.capPct||100:100))+'" style="'+inputS+'"></div>'+
    '</div>'+
    '<div style="display:flex;gap:8px;">'+
      '<button onclick="bankSaveInline()" style="padding:7px 18px;background:var(--brick);color:#fff;border:none;border-radius:var(--radius-sm);font-family:var(--sans);font-size:13px;font-weight:600;cursor:pointer;">Save Goal</button>'+
      '<button onclick="bankCancelInline()" style="padding:7px 14px;background:none;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-family:var(--sans);font-size:13px;cursor:pointer;color:var(--text-muted);">Cancel</button>'+
    '</div>'+
  '</td></tr>';

  var tbody=document.getElementById('bank-tbody');
  if(targetRow){
    targetRow.insertAdjacentHTML('afterend',rowHTML);
  } else if(bankEditIdx!==null){
    var rows=tbody.querySelectorAll('tr[data-idx="'+bankEditIdx+'"]');
    if(rows.length){rows[0].insertAdjacentHTML('afterend',rowHTML);}
    else{tbody.insertAdjacentHTML('beforeend',rowHTML);}
  } else {
    tbody.insertAdjacentHTML('beforeend',rowHTML);
  }
  // Init role dropdown if dept set
  if(g&&g.department) bankInlineDeptChange(g.role);
  bankInlineTypeChange();
  var row=document.getElementById('bank-inline-row');
  if(row) row.scrollIntoView({behavior:'smooth',block:'nearest'});
}

function bankInlineTypeChange(){
  var type=document.getElementById('banki-type')?document.getElementById('banki-type').value:'';
  var locW=document.getElementById('banki-loc-wrap');
  var deptW=document.getElementById('banki-dept-wrap');
  var roleW=document.getElementById('banki-role-wrap');
  if(locW) locW.style.display=(type==='company')?'none':'';
  if(deptW) deptW.style.display=(type==='company')?'none':'';
  if(roleW) roleW.style.display=(type==='individual')?'':'none';
}

function bankInlineDeptChange(preselect){
  var dept=document.getElementById('banki-dept')?document.getElementById('banki-dept').value:'';
  var roleEl=document.getElementById('banki-role');
  if(!roleEl) return;
  var roles=dept&&DEPT_ROLES_MAP[dept]?DEPT_ROLES_MAP[dept]:[];
  roleEl.innerHTML='<option value="">Select role</option>';
  roles.forEach(function(r){var o=document.createElement('option');o.value=r;o.textContent=r;if(preselect&&r===preselect)o.selected=true;roleEl.appendChild(o);});
}

function bankInlineCappedChange(){
  var el=document.getElementById('banki-cappct-wrap');
  if(el) el.style.display=document.getElementById('banki-capped').value==='yes'?'':'none';
}

function bankCancelInline(silent){
  var row=document.getElementById('bank-inline-row');
  if(row) row.remove();
  if(!silent) { bankEditIdx=null; bankEditSbId=null; }
  if(!silent) bankRender();
  // Clean up extra delete option from menu
  var extra=document.getElementById('gs2-row-menu-harddelete');
  if(extra) extra.remove();
  if(!silent) bankEditIdx=null;
}

async function bankSaveInline(){
  var type   =document.getElementById('banki-type')?document.getElementById('banki-type').value:'';
  // Get selected locations from checkboxes
  var locBoxes = ['banki-loc-ut','banki-loc-ga','banki-loc-re'];
  var selectedLocs = locBoxes.map(function(id){
    var el = document.getElementById(id); return el && el.checked ? el.value : null;
  }).filter(Boolean);
  var loc = selectedLocs.length === 1 ? selectedLocs[0] : (selectedLocs.length === 0 ? '' : selectedLocs[0]);
  var dept   =document.getElementById('banki-dept')?document.getElementById('banki-dept').value:'';
  var role   =document.getElementById('banki-role')?document.getElementById('banki-role').value:'';
  var name   =document.getElementById('banki-name')?document.getElementById('banki-name').value.trim():'';
  // For edits, preserve existing goalValue/minValue; for new goals leave blank
  var existingGoal = (bankEditIdx!==null && bankGoals[bankEditIdx]) ? bankGoals[bankEditIdx] : null;
  var target = existingGoal ? (existingGoal.goalValue || '') : '';
  var min    = existingGoal ? (existingGoal.minValue    || '') : '';
  var lower  =document.getElementById('banki-lower')?document.getElementById('banki-lower').value==='true':true;
  var capped =document.getElementById('banki-capped')?document.getElementById('banki-capped').value:'no';
  var capPct =document.getElementById('banki-cappct')?document.getElementById('banki-cappct').value:100;

  if(!type){showToast('Select a goal type','error');return;}
  if(!name){showToast('Goal name is required','error');return;}
  if(type==='company' && currentProfile && currentProfile.role !== 'admin') {
    showToast('Only admins can create company goals','error'); return;
  }

  if((type==='department'||type==='individual')&&!dept){showToast('Department is required','error');return;}
  if(type==='individual'&&!role){showToast('Role is required','error');return;}

  var goal={
    goalTier:type, location:loc, department:dept, role:role,
    name:name,
    goalValue: target!=='' ? parseFloat(target) : (existingGoal ? existingGoal.goalValue : null),
    minValue:  min!==''    ? parseFloat(min)    : (existingGoal ? existingGoal.minValue  : null),
    lowerBetter:lower, capped:capped, capPct:parseInt(capPct)||100,
    active:true, createdAt:new Date().toISOString()
  };

  // Duplicate / similarity check
  if(bankEditIdx===null) {
    var nameLower = name.toLowerCase().replace(/[^a-z0-9]/g,'');
    var similar = bankGoals.filter(function(g) {
      if(g.active===false) return false;
      // Skip the goal being edited
      if(g._sbId && bankEditSbId && g._sbId===bankEditSbId) return false;
      // Must be same tier
      if((g.goalTier||inferTier(g))!==type) return false;
      // For dept/individual goals, must match dept and loc
      if(type!=='company') {
        if(g.department && dept && g.department!==dept) return false;
        if(g.location && loc && g.location!==loc) return false;
      }
      // Check name similarity: exact match or one name contains the other or very close
      var gLower = (g.name||'').toLowerCase().replace(/[^a-z0-9]/g,'');
      if(gLower===nameLower) return true; // exact
      if(gLower.length>=3 && nameLower.indexOf(gLower)!==-1) return true; // existing name inside new
      if(nameLower.length>=3 && gLower.indexOf(nameLower)!==-1) return true; // new name inside existing
      // Levenshtein-like: check if first 4+ chars match
      if(nameLower.length>=4 && gLower.length>=4 && nameLower.substring(0,4)===gLower.substring(0,4)) return true;
      return false;
    });

    if(similar.length>0) {
      var lines = similar.map(function(g){ return '"'+g.name+'" ('+(g.goalTier||inferTier(g))+(g.department?' - '+g.department:'')+(g.location?' - '+g.location:'')+')'; });
      var msg = 'A similar goal already exists:\n\n' + lines.join('\n') + '\n\nSave anyway?';
      if(!confirm(msg)) return;
    }
  }  // Use stored sbId for edits (more reliable than array lookup)
  var editingIdx2 = bankEditIdx;
  var sbId2 = bankEditSbId || ((editingIdx2!==null && bankGoals[editingIdx2]) ? bankGoals[editingIdx2]._sbId : null);

  // Save month target/min
  var monthVal2 = document.getElementById('bank-month') ? document.getElementById('bank-month').value : '';
  var mtEl = document.getElementById('banki-month-target');
  var mmEl = document.getElementById('banki-month-min');

  if (sb && currentUser) {
    // If multiple locations, save one goal per location
    if (selectedLocs.length > 1 && !sbId2) {
      for (var li = 0; li < selectedLocs.length; li++) {
        var locGoal = Object.assign({}, goal, { location: selectedLocs[li] });
        var lRes = await sbSaveGoal(locGoal, null);
        if (lRes && lRes.error) { showToast('Error saving: ' + lRes.error.message, 'error'); return; }
      }
    } else {
      var sbResult = await sbSaveGoal(goal, sbId2);
      if (sbResult && sbResult.error) { showToast('Error saving: ' + sbResult.error.message, 'error'); return; }
      if (sbResult && sbResult.data && sbResult.data.id) goal._sbId = sbResult.data.id;
    }
  } else {
    if(editingIdx2!==null){
      goal.createdAt=bankGoals[editingIdx2].createdAt||goal.createdAt;
      goal.active=bankGoals[editingIdx2].active!==false;
      bankGoals[editingIdx2]=goal;
    } else {
      bankGoals.push(goal);
    }
    await bankSave();
  }

  if (monthVal2 && (mtEl || mmEl)) {
    var mKey2 = goalMKey(goal);
    var targets2 = bankGetMonthTargets(monthVal2);
    if (!targets2[mKey2]) targets2[mKey2] = {};
    if (mtEl && mtEl.value !== '') targets2[mKey2].target = parseFloat(mtEl.value);
    if (mmEl && mmEl.value !== '') targets2[mKey2].min    = parseFloat(mmEl.value);
    bankSaveMonthTargets(monthVal2, targets2);
    // Also save to Supabase so all users see updated targets
    if (sb && currentUser) {
      var period2 = formatMonthLabel(monthVal2) || monthVal2;
      var targetKey = '__target__' + mKey2;
      var minKey    = '__min__'    + mKey2;
      if (mtEl && mtEl.value !== '') await sbSaveActual(period2, targetKey, parseFloat(mtEl.value));
      if (mmEl && mmEl.value !== '') await sbSaveActual(period2, minKey,    parseFloat(mmEl.value));
    }
  }

  showToast('Goal saved to bank!','success');
  bankCancelInline(true);
  bankEditIdx=null;
  bankEditSbId=null;
  await bankLoad();
}

// ── Actuals (Company + Dept) ────────────────────────────────────
var actGoals = [];
var actAllActuals = {};  // {monthKey: {goalKey: value}}
var actEditKey = null;   // 'key|month' of row currently being edited
var ACT_ACTUALS_PREFIX = 'actuals-v1:';

function actGoalKey(g) {
  return [g.goalTier, g.location||'', g.department||'', g.name].join('|');
}

function actLoadAllActuals() {
  actAllActuals = {};
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && k.indexOf(ACT_ACTUALS_PREFIX) === 0) {
      var month = k.replace(ACT_ACTUALS_PREFIX, '');
      try { actAllActuals[month] = JSON.parse(localStorage.getItem(k)); } catch(e) {}
    }
  }
}

function actPopulateMonthFilter() {
  var sel = document.getElementById('act-month');
  if (!sel) return;
  var months = Object.keys(actAllActuals).sort().reverse();
  var now = new Date();
  for (var i = 0; i < 6; i++) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var val = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    if (months.indexOf(val) === -1) months.push(val);
  }
  months.sort().reverse();
  var current = sel.value;
  sel.innerHTML = '<option value="">All months</option>';
  months.forEach(function(m) {
    var opt = document.createElement('option');
    opt.value = m; opt.textContent = formatMonthLabel(m);
    if (m === current) opt.selected = true;
    sel.appendChild(opt);
  });
}

async function actLoad() {
  // Always use bankGoals if already loaded (avoids double fetch)
  if (bankGoals && bankGoals.length > 0) {
    actGoals = bankGoals;
  } else if (sb && currentUser) {
    var data = await sbLoadGoalBank();
    if (data) {
      actGoals = data.map(function(r) {
        return { _sbId:r.id, goalTier:r.goal_tier, location:r.location||'', department:r.department||'',
          name:r.name, goalValue:r.goal_value, minValue:r.min_value,
          lowerBetter:r.lower_better, capped:r.capped, capPct:r.cap_pct, active:r.active };
      });
    }
  } else {
    try { var raw = localStorage.getItem(BANK_KEY); actGoals = raw ? JSON.parse(raw) : []; } catch(e) { actGoals = []; }
  }
  actLoadAllActuals();
  actPopulateMonthFilter();
  await actRender();
}

function actResetFilters() {
  var els = ['act-month','act-type','act-dept','act-loc'];
  els.forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  actRender();
}

async function actRender() {
  var monthF = document.getElementById('act-month') ? document.getElementById('act-month').value : '';
  var typeF  = document.getElementById('act-type')  ? document.getElementById('act-type').value  : '';
  var deptF  = document.getElementById('act-dept')  ? document.getElementById('act-dept').value  : '';
  var locF   = document.getElementById('act-loc')   ? document.getElementById('act-loc').value   : '';

  // Load actuals AND targets from Supabase for this month
  if (sb && currentUser && monthF) {
    var period = formatMonthLabel(monthF); // e.g. 'April 2026'
    var sbActuals = await sbLoadActuals(period);
    if (sbActuals && Object.keys(sbActuals).length) {
      if (!actAllActuals[monthF]) actAllActuals[monthF] = {};
      // Separate targets/mins from actuals
      var sbTargets = {};
      Object.keys(sbActuals).forEach(function(k) {
        if (k.indexOf('__target__') === 0) {
          // key is '__target__goalName' — match against actGoals
          var inner3 = k.replace('__target__','');
          actGoals.forEach(function(g) {
            if (g.name === inner3) {
              var bk3 = goalMKey(g);
              if (!sbTargets[bk3]) sbTargets[bk3] = {};
              sbTargets[bk3].target = sbActuals[k];
            }
          });
        } else if (k.indexOf('__min__') === 0) {
          var inner4 = k.replace('__min__','');
          actGoals.forEach(function(g) {
            if (g.name === inner4) {
              var bk4 = goalMKey(g);
              if (!sbTargets[bk4]) sbTargets[bk4] = {};
              sbTargets[bk4].min = sbActuals[k];
            }
          });
        } else {
          actAllActuals[monthF][k] = sbActuals[k];
        }
      });
      // Merge Supabase targets into localStorage targets
      if (Object.keys(sbTargets).length) {
        var localTargets = bankGetMonthTargets(monthF);
        Object.keys(sbTargets).forEach(function(k) {
          if (!localTargets[k]) localTargets[k] = {};
          if (sbTargets[k].target !== undefined) localTargets[k].target = sbTargets[k].target;
          if (sbTargets[k].min    !== undefined) localTargets[k].min    = sbTargets[k].min;
        });
        bankSaveMonthTargets(monthF, localTargets);
      }
    }
  }

  var monthVal2 = monthF; // e.g. '2026-04'
  var monthTargets2 = monthVal2 ? bankGetMonthTargets(monthVal2) : {};

  // Scope actuals to manager's departments/locations
  var mgDepts = (currentProfile && currentProfile.role !== 'admin') ? (currentProfile.departments||[]) : [];
  var mgLocs  = (currentProfile && currentProfile.role !== 'admin') ? (currentProfile.locations||[])  : [];

  var filtered = actGoals.filter(function(g) {
    if (g.active === false) return false;
    var tier = g.goalTier || inferTier(g);
    if (tier === 'individual') return false;
    if (typeF && tier !== typeF) return false;
    if (deptF && g.department && g.department !== deptF) return false;
    if (locF  && g.location   && g.location   !== locF)  return false;
    // Scope: company goals show for everyone; dept goals scoped to manager's dept/loc
    if (tier === 'department') {
      var deptOk = mgDepts.length === 0 || !g.department || mgDepts.indexOf(g.department) !== -1;
      var locOk  = mgLocs.length  === 0 || !g.location   || mgLocs.indexOf(g.location)   !== -1;
      if (!deptOk || !locOk) return false;
    }
    return true;
  });

  filtered.sort(function(a,b) {
    var to={company:0,department:1};
    var ta=to[a.goalTier||inferTier(a)]||0, tb=to[b.goalTier||inferTier(b)]||0;
    if (ta!==tb) return ta-tb;
    return (a.department||'')<(b.department||'')?-1:1;
  });

  var thead=document.getElementById('act-thead'), tbody=document.getElementById('act-tbody');
  var empty=document.getElementById('act-empty'), title=document.getElementById('act-table-title');
  if (!tbody) return;

  var thS='padding:5px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--text-muted);background:var(--surface2);border-bottom:2px solid var(--border);white-space:nowrap;';
  var colCtx='background:#faf8f5;', colGoal='background:#f2f7fa;', colAct='background:#f5f8f3;';
  var border='border-bottom:1px solid var(--border);';
  var td=function(v,bg,x){return '<td style="padding:5px 6px;'+border+(bg||'')+(x||'')+'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;">'+escAttr(String(v===null||v===undefined?'—':v))+'</td>';};
  var tierColors={company:'#f5e6d3',department:'#d6e8d6'};
  var tierText={company:'#7a3010',department:'#1a5c1a'};

  thead.innerHTML='<tr>'+
    '<th style="'+thS+colCtx+'">Type</th>'+
    '<th style="'+thS+colCtx+'">Location</th>'+
    '<th style="'+thS+colCtx+'">Department</th>'+
    '<th style="'+thS+colGoal+'">Goal Name</th>'+
    '<th style="'+thS+colGoal+'">Target</th>'+
    '<th style="'+thS+colGoal+'">Min</th>'+
    '<th style="'+thS+colGoal+'">Lower</th>'+
    '<th style="'+thS+colGoal+'">Capped</th>'+
    '<th style="'+thS+colAct+'">Month</th>'+
    '<th style="'+thS+colAct+'">Actual</th>'+
    '<th style="'+thS+colAct+'">Achieve%</th>'+
    '<th style="'+thS+'background:#fff;width:30px;"></th>'+
    
  '</tr>';

  if (filtered.length===0) {
    tbody.innerHTML=''; if(empty) empty.style.display='block';
    if(title) title.textContent='Goals'; return;
  }
  if (empty) empty.style.display='none';

  // Which months to show
  var monthsToShow = monthF ? [monthF] : (function(){
    var ms=Object.keys(actAllActuals).sort().reverse().slice(0,3);
    if(!ms.length){ var now=new Date(); ms=[now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')]; }
    return ms;
  })();

  var rows=[];
  filtered.forEach(function(g) {
    var tier=g.goalTier||inferTier(g), key=actGoalKey(g);
    monthsToShow.forEach(function(month) {
      var actual=((actAllActuals[month]||{})[key]);
      actual = actual!==undefined ? actual : '';
      var ach='—', achColor='color:var(--text-muted);';
      if (actual!=='') {
        var lb=g.lowerBetter!==false;
        var mKeyAct0=goalMKey(g);
        var mdAct0=monthTargets2[mKeyAct0]||{};
        var tvAct0=mdAct0.target!==undefined?mdAct0.target:g.goalValue;
        var pct=lb?(parseFloat(tvAct0)/parseFloat(actual))*100:(parseFloat(actual)/parseFloat(tvAct0))*100;
        if(g.capped==='yes') pct=Math.min(pct,parseFloat(g.capPct)||100);
        ach=pct.toFixed(1)+'%'; achColor=pct>=100?'color:#2D6B1A;font-weight:700;':'color:#703c2e;font-weight:700;';
      }
      var mKeyAct=goalMKey(g);
      var mdAct=monthTargets2[mKeyAct]||{};
      var tvAct=mdAct.target!==undefined?mdAct.target:g.goalValue;
      var mvAct=mdAct.min!==undefined?mdAct.min:g.minValue;
      rows.push({g:g,tier:tier,key:key,month:month,actual:actual,ach:ach,achColor:achColor,target:tvAct,min:mvAct});
    });
  });

  if(title) title.textContent='Goals ('+filtered.length+')';

  tbody.innerHTML=rows.map(function(r) {
    var g=r.g, tier=r.tier;
    return '<tr data-key="'+escAttr(r.key)+'" data-month="'+escAttr(r.month)+'">'+
      '<td style="padding:5px 6px;'+border+colCtx+'"><span style="font-size:9px;padding:1px 5px;border-radius:99px;background:'+(tierColors[tier]||'#eee')+';color:'+(tierText[tier]||'#333')+';font-weight:700;">'+(tier==='company'?'Co':'Dept')+'</span></td>'+
      td(g.location||'—',colCtx)+td(g.department||'—',colCtx)+
      '<td style="padding:5px 6px;'+border+colGoal+'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;">'+escAttr(g.name||'')+'</td>'+
      (function(){
        var mKey2=(g._sbId||g.name)+'|'+(g.goalTier||'');
        var md=monthTargets2[mKey2]||{};
        var tv=md.target!==undefined?md.target:g.goalValue;
        var mv=md.min!==undefined?md.min:g.minValue;
        return td(tv,colGoal)+td(mv,colGoal);
      })()+
      td(g.lowerBetter!==false?'Yes':'No',colGoal)+td(g.capped==='yes'?'Yes':'No',colGoal)+
      '<td style="padding:5px 6px;'+border+colAct+'font-size:10px;color:var(--text-muted);">'+escAttr(formatMonthLabel(r.month))+'</td>'+
      '<td style="padding:3px 5px;'+border+colAct+'">'+
        (function(){
          var isAdmin2 = !currentProfile || currentProfile.role === 'admin';
          var tier2 = g.goalTier||inferTier(g);
          var isCompany2 = tier2 === 'company';
          // Use month-specific target/min if available, fall back to goal defaults
          var tv = (r.target!==undefined&&r.target!==null&&r.target!=='') ? r.target : g.goalValue;
          var mv = (r.min!==undefined&&r.min!==null&&r.min!=='') ? r.min : g.minValue;
          var noTargetMin = (tv===undefined||tv===null||tv==='') || (mv===undefined||mv===null||mv==='');
          if (noTargetMin) return '<span style="font-size:10px;color:var(--text-muted);font-family:var(--mono);padding:2px 4px;background:var(--surface2);border-radius:3px;display:inline-block;" title="Set Target and Minimum in Goal Bank first">No target/min set</span>';
          if (isCompany2 && !isAdmin2) return '<span style="font-size:11px;font-family:var(--mono);color:var(--text);">'+(r.actual!==null&&r.actual!==''?r.actual:'—')+'</span>';
          var isEditing = actEditKey === (r.key+'|'+r.month);
          if (!isEditing) return '<span style="font-size:11px;font-family:var(--mono);color:var(--text);cursor:default;">'+(r.actual!==null&&r.actual!==''?r.actual:'—')+'</span>';
          return '<input type="number" step="any" value="'+escAttr(String(r.actual))+'" data-key="'+escAttr(r.key)+'" data-month="'+escAttr(r.month)+'" oninput="actMarkDirty()" style="width:100%;padding:3px 4px;font-size:11px;font-family:var(--mono);border:1.5px solid var(--brick);border-radius:4px;background:#fff;" autofocus>';
        })()+
      '</td>'+
      '<td style="padding:5px 6px;'+border+colAct+r.achColor+'">'+r.ach+'</td>'+
      '<td style="padding:3px 4px;'+border+'background:#fff;">'+
        ((r.tier!=='company' || !currentProfile || currentProfile.role==='admin') ?
          '<button onclick="actOpenEdit(this)" data-editkey="'+escAttr(r.key)+'|'+escAttr(r.month)+'" style="padding:2px 4px;border:none;background:none;font-size:14px;cursor:pointer;color:var(--text-muted);line-height:1;letter-spacing:1px;">&#8942;</button>'
          : '') +
      '</td>'+
    '</tr>';
  }).join('');
}

function actOpenEdit(btn) {
  var keyMonth = btn.dataset ? btn.dataset.editkey : btn;
  actEditKey = actEditKey === keyMonth ? null : keyMonth;
  actRender();
  // Focus input if opened
  if (actEditKey) {
    setTimeout(function() {
      var inp = document.querySelector('#act-tbody input[type="number"]');
      if (inp) inp.focus();
    }, 50);
  }
}

function actMarkDirty() {
  var bar = document.getElementById('act-save-bar');
  if (bar) bar.style.display = 'block';
}

async function actSaveAll() {
  var inputs = document.querySelectorAll('#act-tbody input[type="number"]');
  inputs.forEach(function(inp) {
    var key = inp.dataset.key, month = inp.dataset.month;
    if (!key || !month) return;
    var val = inp.value !== '' ? parseFloat(inp.value) : null;
    if (!actAllActuals[month]) actAllActuals[month] = {};
    if (val !== null) actAllActuals[month][key] = val;
    else delete actAllActuals[month][key];
    localStorage.setItem(ACT_ACTUALS_PREFIX + month, JSON.stringify(actAllActuals[month]));
  });
  if (sb && currentUser) {
    var saves = [];
    inputs.forEach(function(inp) {
      var key = inp.dataset.key, month = inp.dataset.month;
      var val = inp.value !== '' ? parseFloat(inp.value) : null;
      if (key && month && val !== null) {
        // Save to Supabase using formatted period like 'April 2026'
        var period = formatMonthLabel(month) || month;
        saves.push(sbSaveActual(period, key, val));
      }
    });
    await Promise.all(saves);
  }
  var bar = document.getElementById('act-save-bar');
  if (bar) bar.style.display = 'none';
  actEditKey = null;
  showToast('Actuals saved!', 'success');
  actRender();
}

async function actSaveRow(btn) { await actSaveAll(); }

function actExportCSV() {
  var monthF=document.getElementById('act-month')?document.getElementById('act-month').value:'';
  var rows=[['Month','Type','Location','Department','Goal Name','Target','Min','Lower Better','Capped','Actual','Achievement']];
  var months=monthF?[monthF]:Object.keys(actAllActuals).sort();
  actGoals.filter(function(g){return g.active!==false&&(g.goalTier||inferTier(g))!=='individual';}).forEach(function(g){
    var key=actGoalKey(g);
    months.forEach(function(month){
      var actual=(actAllActuals[month]||{})[key];
      if(actual===undefined) return;
      var lb=g.lowerBetter!==false;
      var pct=lb?(parseFloat(g.goalValue)/parseFloat(actual))*100:(parseFloat(actual)/parseFloat(g.goalValue))*100;
      if(g.capped==='yes') pct=Math.min(pct,parseFloat(g.capPct)||100);
      rows.push([formatMonthLabel(month),g.goalTier||inferTier(g),g.location||'',g.department||'',g.name,g.goalValue,g.minValue,lb?'Yes':'No',g.capped==='yes'?'Yes':'No',actual,pct.toFixed(1)+'%']);
    });
  });
  var csv=rows.map(function(r){return r.map(function(c){return '"'+String(c).replace(/"/g,'""')+'"';}).join(',');}).join('\n');
  var a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv); a.download='actuals.csv'; a.click();
}
// ── Build Scorecard ─────────────────────────────────────────────
var scEmployee = null;   // selected Rippling employee
var scGoals = [];        // goals on this scorecard [{...goal, weight, targetOverride, actual}]

var scPeriodType = 'monthly';

function scSetPeriodType(type) {
  scPeriodType = type;
  var mBtn = document.getElementById('sc-period-monthly');
  var qBtn = document.getElementById('sc-period-quarterly');
  var mField = document.getElementById('sc-month-field');
  var qField = document.getElementById('sc-quarter-field');
  if (mBtn) mBtn.className = 'period-btn' + (type === 'monthly' ? ' active' : '');
  if (qBtn) qBtn.className = 'period-btn' + (type === 'quarterly' ? ' active' : '');
  if (mField) mField.style.display = type === 'monthly' ? '' : 'none';
  if (qField) qField.style.display = type === 'quarterly' ? '' : 'none';
  // Recalculate salary earnings whenever period type changes
  var payType = document.getElementById('sc-paytype');
  if (payType && payType.value === 'salary') scCalcEarnings();
}

function scGetPeriodLabel() {
  if (scPeriodType === 'quarterly') {
    var q = document.getElementById('sc-quarter');
    var y = document.getElementById('sc-year');
    return (q && y) ? q.value + ' ' + y.value : '';
  }
  var m = document.getElementById('sc-month');
  return (m && m.value) ? formatMonthLabel(m.value) : '';
}

function scUnlock(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.removeAttribute('readonly');
  el.style.background = '#fff';
  el.style.borderColor = 'var(--brick)';
  el.focus();
}

function scPayTypeChange() {
  var type = document.getElementById('sc-paytype').value;
  var hoursField  = document.getElementById('sc-hours-field');

  var rateLabel   = document.getElementById('sc-rate-label');
  var isHourly    = type === 'hourly';
  if (hoursField)  hoursField.style.display  = isHourly ? '' : 'none';

  if (rateLabel)   rateLabel.textContent     = isHourly ? 'Hourly rate ($)' : 'Annual salary ($)';
  scCalcEarnings();
}

function scCalcEarnings() {
  var type       = document.getElementById('sc-paytype').value;
  var rate       = parseFloat(document.getElementById('sc-rate') ? document.getElementById('sc-rate').value : 0) || 0;
  var earningsEl = document.getElementById('sc-earnings');
  if (!earningsEl) return;
  if (type === 'salary' && rate) {
    // Always calculate salary earnings from annual pay ÷ period
    var divisor = scPeriodType === 'quarterly' ? 4 : 12;
    earningsEl.value = (rate / divisor).toFixed(2);
  }
  // For hourly: gross earnings (incl. OT) come from Rippling's Base Pay column — leave as-is
}

async function scTypeahead(query) {
  var sug = document.getElementById('sc-suggestions');
  if (!sug) return;
  if (!query || query.length < 2) { sug.style.display = 'none'; return; }

  // Use the same robust lookup as the actuals tab typeahead
  var employees = [];
  var now = new Date();
  var curLabel = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleString('default', {month:'long',year:'numeric'});
  employees = await getRipplingEmployees(curLabel);

  // Fallback: scan all rippling keys in localStorage
  if (!employees.length) {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('rippling:') === 0) {
        try { var d = JSON.parse(localStorage.getItem(k)); if (d&&d.length) { employees = d; break; } } catch(e) {}
      }
    }
  }

  // Fallback: scan window.storage index
  if (!employees.length) {
    try {
      var idxRaw = await storageGet('rippling-months-index');
      var months = idxRaw ? JSON.parse(idxRaw) : [];
      for (var mi = 0; mi < months.length; mi++) {
        var d2 = await getRipplingEmployees(months[mi]);
        if (d2.length) { employees = d2; break; }
      }
    } catch(e2) {}
  }

  var q = query.toLowerCase();
  var matches = employees.filter(function(e) { return e.name && e.name.toLowerCase().indexOf(q) !== -1; }).slice(0, 8);
  if (!matches.length) { sug.style.display = 'none'; return; }
  sug.style.display = 'block';
  sug.innerHTML = matches.map(function(e) {
    var pay = e.grossEarnings ? '$' + parseFloat(e.grossEarnings).toFixed(2) + ' gross' : (e.payType === 'salary' ? '$' + parseFloat(e.annualPay||0).toLocaleString() + '/yr' : '$' + (e.hourlyRate||0) + '/hr');
    var hrs = e.hoursWorked ? ' &middot; ' + parseFloat(e.hoursWorked).toFixed(1) + ' hrs' : '';
    var eJson = JSON.stringify(e).replace(/"/g, '&quot;');
    return '<div onclick="scSelectEmployee(JSON.parse(this.dataset.emp))" data-emp="' + eJson + '" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);" onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'none\'">' +
      '<div style="font-size:13px;font-weight:600;color:var(--text);">' + escAttr(e.name) + '</div>' +
      '<div style="font-size:11px;color:var(--text-muted);">' + escAttr(e.role||'') + ' &middot; ' + escAttr(e.department||'') + ' &middot; ' + pay + hrs + '</div>' +
    '</div>';
  }).join('');
}

async function scSelectEmployee(e) {
  scEmployee = e;
  var sug = document.getElementById('sc-suggestions');
  if (sug) sug.style.display = 'none';
  document.getElementById('sc-name').value = e.name;
  document.getElementById('sc-role').value = e.role || '';
  document.getElementById('sc-dept').value = e.department || '';
  document.getElementById('sc-loc').value  = e.location || '';
  // Re-lock all auto-filled fields
  ['sc-role','sc-dept','sc-loc','sc-rate','sc-hours','sc-earnings','sc-manager'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) { el.setAttribute('readonly', true); el.style.background = 'var(--surface2)'; el.style.borderColor = 'var(--border)'; }
  });
  var payEl = document.getElementById('sc-paytype');
  var rateEl = document.getElementById('sc-rate');
  // Set hidden paytype value and update display
  if (payEl) payEl.value = e.payType || 'hourly';
  scPayTypeChange();
  if (rateEl) {
    rateEl.value = e.payType === 'salary' ? (e.annualPay||'') : (e.hourlyRate||'');
  }
  // Auto-fill manager
  var managerEl = document.getElementById('sc-manager');
  if (managerEl && e.manager) { managerEl.value = e.manager; managerEl.setAttribute('readonly', true); managerEl.style.background='var(--surface2)'; managerEl.style.borderColor='var(--border)'; }

  var earningsEl = document.getElementById('sc-earnings');
  var hoursEl    = document.getElementById('sc-hours');

  if (e.payType === 'hourly') {
    // Hourly: Base Pay = actual gross earnings from Rippling (includes OT)
    if (earningsEl && e.grossEarnings) earningsEl.value = parseFloat(e.grossEarnings).toFixed(2);
    // Hours worked from Rippling
    if (hoursEl && e.hoursWorked) hoursEl.value = parseFloat(e.hoursWorked).toFixed(2);
  } else {
    // Salary: calculate from annual pay ÷ period
    if (hoursEl && e.hoursWorked) hoursEl.value = parseFloat(e.hoursWorked).toFixed(2);
    scCalcEarnings(); // will divide annual by 12 or 4 based on period type
  }
  await scLoadGoals();
}

async function scOnMonthChange() {
  await scLoadActuals();
  scRender();
}

async function scOnQuarterChange() {
  await scLoadActuals();
  scRender();
}

async function scLoadGoals() {
  if (!scEmployee) return;
  var role = scEmployee.role || '';
  var dept = scEmployee.department || '';
  var loc  = scEmployee.location || '';

  // Load from Supabase first, fall back to localStorage
  var bank = [];
  if (sb && currentUser) {
    var bankData = await sbLoadGoalBank();
    if (bankData && bankData.length) {
      bank = bankData.map(function(r) {
        return { _sbId:r.id, goalTier:r.goal_tier, location:r.location||'', department:r.department||'',
          role:r.role||'', name:r.name, goalValue:r.goal_value, minValue:r.min_value,
          lowerBetter:r.lower_better, capped:r.capped, capPct:r.cap_pct, active:r.active };
      });
    }
  }
  if (!bank.length) {
    try { var raw = localStorage.getItem(BANK_KEY); bank = raw ? JSON.parse(raw) : []; } catch(e) {}
  }

  // Load month targets for this scorecard period
  var scMonthVal = document.getElementById('sc-month') ? document.getElementById('sc-month').value : '';
  var scMonthTargets = scMonthVal ? bankGetMonthTargets(scMonthVal) : {};

  // Load targets AND actuals from Supabase for this month
  if (sb && currentUser && scMonthVal) {
    var scPeriod = formatMonthLabel(scMonthVal);
    var scSbActuals = await sbLoadActuals(scPeriod);
    if (scSbActuals) {
      Object.keys(scSbActuals).forEach(function(k) {
        if (k.indexOf('__target__') === 0) {
          var goalName = k.replace('__target__','');
          // Match against bank goals to build correct key
          bank.forEach(function(g) {
            if (g.name === goalName) {
              var bk = g.name + '|' + (g.goalTier||inferTier(g));
              if (!scMonthTargets[bk]) scMonthTargets[bk] = {};
              scMonthTargets[bk].target = scSbActuals[k];
            }
          });
        } else if (k.indexOf('__min__') === 0) {
          var goalName2 = k.replace('__min__','');
          bank.forEach(function(g) {
            if (g.name === goalName2) {
              var bk2 = g.name + '|' + (g.goalTier||inferTier(g));
              if (!scMonthTargets[bk2]) scMonthTargets[bk2] = {};
              scMonthTargets[bk2].min = scSbActuals[k];
            }
          });
        }
      });
      // Also cache actuals for pre-filling
      if (!actAllActuals[scMonthVal]) actAllActuals[scMonthVal] = {};
      Object.keys(scSbActuals).forEach(function(k) {
        if (k.indexOf('__target__') !== 0 && k.indexOf('__min__') !== 0) {
          actAllActuals[scMonthVal][k] = scSbActuals[k];
        }
      });
    }
  }

  scGoals = bank.filter(function(g) {
    if (g.active === false) return false;
    var tier = g.goalTier || inferTier(g);
    if (tier === 'company') return true;
    if (tier === 'individual') return (!g.role || g.role === role) && (!g.department || g.department === dept);
    return false;
  }).map(function(g) {
    var mKeyG = goalMKey(g);
    var mdG = scMonthTargets[mKeyG] || {};
    return Object.assign({}, g, {
      scWeight: g.defaultWeight || '',
      scTarget: mdG.target !== undefined ? mdG.target : g.goalValue,
      minValue: mdG.min    !== undefined ? mdG.min    : g.minValue,
      scActual: ''
    });
  });

  // Department goals available as a picker (matching dept only)
  var deptGoals = bank.filter(function(g) {
    if (g.active === false) return false;
    var tier = g.goalTier || inferTier(g);
    return tier === 'department' && (!g.department || g.department === dept) && (!g.location || g.location === loc);
  }).map(function(g) {
    var mKeyD = goalMKey(g);
    var mdD = scMonthTargets[mKeyD] || {};
    var resolvedTarget = mdD.target !== undefined ? mdD.target : g.goalValue;
    var resolvedMin    = mdD.min    !== undefined ? mdD.min    : g.minValue;
    return Object.assign({}, g, {
      scTarget: resolvedTarget,
      minValue: resolvedMin,
      goalValue: resolvedTarget  // ensure goalValue is also updated
    });
  });

  await scLoadActuals();

  document.getElementById('sc-goals-section').style.display = 'block';
  document.getElementById('sc-goals-empty').style.display = scGoals.length === 0 ? 'block' : 'none';
  document.getElementById('sc-add-goals-section').style.display = deptGoals.length > 0 ? 'block' : 'none';
  document.getElementById('sc-submit-section').style.display = 'block';
  // Only show dept goals not already on the scorecard
  var deptGoalsFiltered = deptGoals.filter(function(g) {
    return !scGoals.some(function(sg) { return sg.name === g.name && (sg.goalTier||'') === (g.goalTier||''); });
  });
  var section = document.getElementById('sc-add-goals-section');
  if (section) section.style.display = deptGoalsFiltered.length > 0 ? 'block' : 'none';
  scRenderDeptPicker(deptGoalsFiltered);
  scRender();
}

async function scLoadActuals() {
  var rawMonth = document.getElementById('sc-month') ? document.getElementById('sc-month').value : '';
  if (!rawMonth) return;
  var month = formatMonthLabel(rawMonth) || rawMonth;

  // Get actuals from cache (already loaded from Supabase in scLoadGoals)
  var actuals = actAllActuals[rawMonth] || {};

  // Also check localStorage
  var saved = localStorage.getItem(ACT_ACTUALS_PREFIX + rawMonth) || localStorage.getItem(ACT_ACTUALS_PREFIX + month);
  if (saved) {
    var localActuals = JSON.parse(saved);
    Object.assign(actuals, localActuals);
  }

  // Pre-fill actuals for company + dept goals
  scGoals.forEach(function(g) {
    var tier = g.goalTier || inferTier(g);
    if (tier === 'company' || tier === 'department') {
      var key = [tier, g.location||'', g.department||'', g.name].join('|');
      if (actuals[key] !== undefined) g.scActual = actuals[key];
    }
  });
}

function scRenderBankPicker(bank, dept, loc, role) {
  var picker = document.getElementById('sc-bank-picker');
  if (!picker) return;
  // Show bank goals not already on scorecard, filtered to matching loc/dept/role
  var onCard = scGoals.map(function(g) { return g.name + '|' + (g.goalTier||''); });
  var available = bank.filter(function(g) {
    if (g.active === false) return false;
    if (onCard.indexOf(g.name + '|' + (g.goalTier||'')) !== -1) return false;
    var tier = g.goalTier || inferTier(g);
    // Company goals always available
    if (tier === 'company') return true;
    // Dept goals must match dept (and location if set)
    if (tier === 'department') {
      if (g.department && g.department !== dept) return false;
      if (g.location && g.location !== loc) return false;
      return true;
    }
    // Individual goals must match role and dept
    if (tier === 'individual') {
      if (g.department && g.department !== dept) return false;
      if (g.location && g.location !== loc) return false;
      if (g.role && g.role !== role) return false;
      return true;
    }
    return false;
  });
  if (!available.length) { picker.innerHTML = '<span style="font-size:12px;color:var(--text-muted);font-family:var(--mono);">All active bank goals are already on this scorecard.</span>'; return; }
  var tierColors = {company:'#f5e6d3',department:'#d6e8d6',individual:'#d3e4f5'};
  var tierText   = {company:'#7a3010',department:'#1a5c1a',individual:'#0a3d6b'};
  picker.innerHTML = available.map(function(g, i) {
    var tier = g.goalTier||inferTier(g);
    var gJson = JSON.stringify(g).replace(/"/g,'&quot;');
    return '<div onclick="scAddFromBank(JSON.parse(this.dataset.g))" data-g="'+gJson+'" style="padding:6px 12px;border:1.5px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;display:flex;align-items:center;gap:6px;background:var(--surface);" onmouseover="this.style.borderColor=\'var(--brick)\'" onmouseout="this.style.borderColor=\'var(--border)\'">' +
      '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:'+(tierColors[tier]||'#eee')+';color:'+(tierText[tier]||'#333')+';font-weight:700;">'+(tier==='company'?'Co':tier==='department'?'Dept':'Indiv')+'</span>' +
      '<span style="font-size:12px;color:var(--text);">'+escAttr(g.name)+'</span>' +
    '</div>';
  }).join('');
}

function scRenderDeptPicker(deptGoals) {
  var picker = document.getElementById('sc-bank-picker');
  if (!picker) return;
  if (!deptGoals.length) {
    picker.innerHTML = '<span style="font-size:12px;color:var(--text-muted);font-family:var(--mono);">No department goals found in the Goal Bank for this department.</span>';
    return;
  }
  var tierColors = {department:'#d6e8d6'};
  var tierText   = {department:'#1a5c1a'};
  picker.innerHTML = deptGoals.map(function(g) {
    var onCard = scGoals.some(function(sg) { return sg.name === g.name && (sg.goalTier||'') === (g.goalTier||''); });
    var gJson = JSON.stringify(g).replace(/"/g,'&quot;');
    return '<div onclick="scToggleDeptGoal(JSON.parse(this.dataset.g),this)" data-g="'+gJson+'" '+
      'style="padding:6px 12px;border:1.5px solid '+(onCard?'var(--brick)':'var(--border)')+';border-radius:var(--radius-sm);cursor:pointer;display:flex;align-items:center;gap:6px;background:'+(onCard?'var(--brick-light)':'var(--surface)')+';" '+
      'onmouseover="this.style.opacity=\'0.8\'" onmouseout="this.style.opacity=\'1\'">' +
      '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:#d6e8d6;color:#1a5c1a;font-weight:700;">Dept</span>' +
      '<span style="font-size:12px;color:var(--text);">'+escAttr(g.name)+'</span>' +
      (onCard ? '<span style="font-size:10px;color:var(--brick);">✓</span>' : '') +
    '</div>';
  }).join('');
}

function scToggleDeptGoal(g, el) {
  var onCard = scGoals.some(function(sg) { return sg.name === g.name && (sg.goalTier||'') === (g.goalTier||''); });
  if (onCard) {
    // Remove from scorecard — put back in picker
    scGoals = scGoals.filter(function(sg) { return !(sg.name === g.name && (sg.goalTier||'') === (g.goalTier||'')); });
  } else {
    // Add to scorecard — remove from picker
    scGoals.push(Object.assign({}, g, { scWeight: g.defaultWeight||'', scTarget: g.goalValue, scActual: '' }));
  }
  // Re-render both the scorecard table and the dept picker
  scRender();
  // Rebuild the dept picker without goals already on the card
  var dept = scEmployee ? scEmployee.department || '' : '';
  var loc  = scEmployee ? scEmployee.location  || '' : '';
  var bank = [];
  try { bank = JSON.parse(localStorage.getItem(BANK_KEY)||'[]'); } catch(e) {}
  var deptGoals = bank.filter(function(g2) {
    if (g2.active === false) return false;
    var tier = g2.goalTier || inferTier(g2);
    return tier === 'department' && (!g2.department || g2.department === dept) && (!g2.location || g2.location === loc);
  }).filter(function(g2) {
    // Only show goals NOT already on the scorecard
    return !scGoals.some(function(sg) { return sg.name === g2.name && (sg.goalTier||'') === (g2.goalTier||''); });
  });
  var section = document.getElementById('sc-add-goals-section');
  if (section) section.style.display = deptGoals.length > 0 ? 'block' : 'none';
  scRenderDeptPicker(deptGoals);
}

function scAddFromBank(g) {
  scGoals.push(Object.assign({}, g, {scWeight:'', scTarget:g.goalValue, scActual:''}));
  scRender();
  scRenderBankPicker(JSON.parse(localStorage.getItem(BANK_KEY)||'[]'),
    document.getElementById('sc-dept').value,
    document.getElementById('sc-loc').value,
    document.getElementById('sc-role').value);
}

function scAddMiscGoal() {
  scGoals.push({goalTier:'individual', name:'', scWeight:'', scTarget:'', scActual:'', minValue:'', lowerBetter:true, capped:'no', capPct:100, isMisc:true});
  scRender();
  // Scroll to last row
  var tbody = document.getElementById('sc-tbody');
  if (tbody) tbody.lastElementChild && tbody.lastElementChild.scrollIntoView({behavior:'smooth',block:'nearest'});
}

function scRender() {
  var thead = document.getElementById('sc-thead');
  var tbody = document.getElementById('sc-tbody');
  if (!thead || !tbody) return;

  var thS = 'padding:5px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--text-muted);background:var(--surface2);border-bottom:2px solid var(--border);white-space:nowrap;';
  var colCtx='background:#faf8f5;', colGoal='background:#f2f7fa;', colAct='background:#f5f8f3;';
  thead.innerHTML = '<tr>' +
    '<th style="'+thS+colCtx+'">Type</th>' +
    '<th style="'+thS+colCtx+'">Department</th>' +
    '<th style="'+thS+colCtx+'">Role</th>' +
    '<th style="'+thS+colGoal+'">Goal Name</th>' +
    '<th style="'+thS+colGoal+'">Weight %</th>' +
    '<th style="'+thS+colGoal+'">Target</th>' +
    '<th style="'+thS+colGoal+'">Min</th>' +
    '<th style="'+thS+colGoal+'">Lower Better</th>' +
    '<th style="'+thS+colAct+'">Actual</th>' +
    '<th style="'+thS+colAct+'">Achieve%</th>' +
    '<th style="'+thS+'background:#fff;"></th>' +
  '</tr>';

  var tierColors={company:'#f5e6d3',department:'#d6e8d6',individual:'#d3e4f5'};
  var tierText={company:'#7a3010',department:'#1a5c1a',individual:'#0a3d6b'};
  var border='border-bottom:1px solid var(--border);';

  var totalWeight = scGoals.reduce(function(s,g){return s+(parseFloat(g.scWeight)||0);},0);
  var weightOk = Math.abs(totalWeight-100)<0.01;
  var weightStatus = document.getElementById('sc-weight-status');
  if (weightStatus) {
    weightStatus.textContent = 'Total weight: '+totalWeight.toFixed(0)+'% '+(weightOk?'✓':'(must equal 100%)');
    weightStatus.style.color = weightOk ? '#2D6B1A' : '#703c2e';
  }

  

  tbody.innerHTML = scGoals.map(function(g,i) {
    var tier = g.goalTier||inferTier(g);
    var isDeptOrCo = tier==='company'||tier==='department';
    var actual = g.scActual!==null&&g.scActual!==undefined&&g.scActual!==''?parseFloat(g.scActual):'';
    var ach='—', achColor='color:var(--text-muted);';
    if (actual!=='' && g.scTarget) {
      var lb=g.lowerBetter!==false;
      var pct=lb?(parseFloat(g.scTarget)/actual)*100:(actual/parseFloat(g.scTarget))*100;
      if(g.capped==='yes') pct=Math.min(pct,parseFloat(g.capPct)||100);
      ach=pct.toFixed(1)+'%';
      achColor=pct>=100?'color:#2D6B1A;font-weight:700;':'color:#703c2e;font-weight:700;';
    }
    var lowerOpts='<option value="true"'+(g.lowerBetter!==false?' selected':'')+'>Yes</option><option value="false"'+(g.lowerBetter===false?' selected':'')+'>No</option>';
    return '<tr data-sci="'+i+'">'+
      '<td style="padding:5px 6px;'+border+colCtx+'"><span style="font-size:9px;padding:1px 5px;border-radius:99px;background:'+(tierColors[tier]||'#eee')+';color:'+(tierText[tier]||'#333')+';font-weight:700;">'+(tier==='company'?'Co':tier==='department'?'Dept':'Indiv')+'</span></td>'+
      '<td style="padding:4px 4px;'+border+colCtx+'">'+(g.isMisc?'<span style="font-size:10px;color:var(--text-muted);">Misc</span>':escAttr(g.department||'—'))+'</td>'+
      '<td style="padding:4px 4px;'+border+colCtx+'">'+(g.isMisc?'':escAttr(g.role||'—'))+'</td>'+
      '<td style="padding:4px 4px;'+border+colGoal+'">'+(g.isMisc?'<input id="sc-'+i+'-name" type="text" value="'+escAttr(g.name||'')+'" placeholder="Goal name" onblur="scGoals['+i+'].name=this.value" style="width:100%;padding:2px 4px;font-size:11px;font-family:var(--mono);border:1.5px solid var(--border);border-radius:3px;">':'<strong>'+escAttr(g.name)+'</strong>')+'</td>'+
      '<td style="padding:4px 4px;'+border+colGoal+'"><input id="sc-'+i+'-weight" type="number" step="any" value="'+escAttr(String(g.scWeight||''))+'" placeholder="%" onblur="scGoals['+i+'].scWeight=this.value;scRender()" style="width:100%;padding:2px 4px;font-size:11px;font-family:var(--mono);border:1.5px solid '+(weightOk?'var(--border)':'#e0a0a0')+';border-radius:3px;"></td>'+
      '<td style="padding:4px 4px;'+border+colGoal+'"><span style="font-size:11px;font-family:var(--mono);color:var(--text);">'+(g.scTarget!==undefined&&g.scTarget!==''?g.scTarget:'—')+'</span></td>'+
      '<td style="padding:4px 4px;'+border+colGoal+'"><span style="font-size:11px;font-family:var(--mono);color:var(--text);">'+(g.minValue!==undefined&&g.minValue!==''?g.minValue:'—')+'</span></td>'+
      '<td style="padding:4px 4px;'+border+colGoal+'"><select id="sc-'+i+'-lower" onchange="scGoals['+i+'].lowerBetter=(this.value===\'true\');scRender()" style="width:100%;padding:2px 3px;font-size:11px;font-family:var(--sans);border:1.5px solid var(--border);border-radius:3px;">'+lowerOpts+'</select></td>'+
      '<td style="padding:4px 4px;'+border+colAct+'">'+
        (isDeptOrCo
          ? '<span style="font-size:11px;color:'+(actual!==''?'var(--text)':'var(--text-muted)')+';">'+(actual!==''?actual:'—')+'</span>'
          : '<input id="sc-'+i+'-actual" type="number" step="any" value="'+escAttr(String(g.scActual||''))+'" placeholder="Actual" onblur="scGoals['+i+'].scActual=this.value;scRender()" style="width:100%;padding:2px 4px;font-size:11px;font-family:var(--mono);border:1.5px solid var(--border);border-radius:3px;">')+
      '</td>'+
      '<td style="padding:5px 6px;'+border+colAct+achColor+'">'+ach+'</td>'+
      '<td style="padding:5px 6px;'+border+'background:#fff;">'+
        '<button onclick="scRemoveGoal('+i+')" title="Remove" style="padding:2px 5px;border:none;background:none;font-size:14px;cursor:pointer;color:var(--text-muted);" onmouseover="this.style.color=\'var(--brick)\'" onmouseout="this.style.color=\'var(--text-muted)\'">\xd7</button>'+
      '</td>'+
    '</tr>';
  }).join('');

  // ── Summary panel ──
  var earnings = parseFloat(document.getElementById('sc-earnings').value)||0;
  var payType  = document.getElementById('sc-paytype') ? document.getElementById('sc-paytype').value : 'hourly';
  var hours    = parseFloat(document.getElementById('sc-hours') ? document.getElementById('sc-hours').value : 0)||0;
  var summary  = document.getElementById('sc-summary');
  if (!summary) return;

  var weightedAch = scGoals.reduce(function(s,g){
    var actual = (g.scActual!==''&&g.scActual!==null&&g.scActual!==undefined) ? parseFloat(g.scActual) : null;
    if (actual===null||!g.scTarget) return s;
    var lb = g.lowerBetter!==false;
    var minV = parseFloat(g.minValue);
    // If minimum not met → no contribution
    if (!isNaN(minV)) {
      var metMin = lb ? (actual <= minV) : (actual >= minV);
      if (!metMin) return s;
    }
    var pct = lb ? (parseFloat(g.scTarget)/actual)*100 : (actual/parseFloat(g.scTarget))*100;
    if (g.capped==='yes') pct = Math.min(pct, parseFloat(g.capPct)||100);
    return s + (pct*(parseFloat(g.scWeight)||0)/100);
  }, 0);

  var capped   = weightedAch > 200;
  var achFinal = capped ? 200 : weightedAch;
  var bonusPct = achFinal * 0.1;
  var bonus    = earnings * (achFinal/100) * 0.1;
  var totalPay = earnings + bonus;
  var effHourly = (hours > 0) ? totalPay / hours : 0;

  if (!earnings) {
    summary.innerHTML = '<span style="color:var(--text-muted);font-family:var(--mono);font-size:12px;">Enter base earnings above to see calculated totals.</span>';
    return;
  }

  var card = function(label, val, highlight) {
    return '<div style="background:'+(highlight?'var(--brick-light)':'var(--surface2)')+';border:1.5px solid '+(highlight?'var(--taupe)':'var(--border)')+';border-radius:var(--radius-sm);padding:12px 14px;">' +
      '<div style="font-size:9px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;font-family:var(--mono);margin-bottom:4px;">'+label+'</div>' +
      '<div style="font-size:17px;font-weight:700;color:'+(highlight?'var(--brick)':'var(--text)')+';">'+val+'</div>' +
    '</div>';
  };

  var html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px;">';
  html += card('BASE EARNINGS', '$'+earnings.toFixed(2));
  html += card('WEIGHTED ACHIEVEMENT', achFinal.toFixed(1)+'%'+(capped?' ↓':''), true);
  html += card('EFFECTIVE BONUS %', bonusPct.toFixed(2)+'%', true);
  html += card('BONUS AMOUNT', '$'+bonus.toFixed(2), true);
  html += card('TOTAL PAY', '$'+totalPay.toFixed(2));
  if (payType === 'hourly' && hours > 0) html += card('EFFECTIVE HOURLY RATE', '$'+effHourly.toFixed(2)+'/hr');
  html += '</div>';

  if (capped) html += '<div style="padding:8px 12px;background:#FFF8E1;border-radius:var(--radius-sm);font-size:12px;color:#8C5A00;font-family:var(--mono);margin-bottom:10px;">&#9888; Achievement of '+weightedAch.toFixed(1)+'% capped at 200%</div>';
  if (!capped && achFinal >= 120) html += '<div style="padding:8px 12px;background:#eef5ec;border-radius:var(--radius-sm);font-size:12px;color:#1a5c1a;font-family:var(--mono);margin-bottom:10px;">&#9650; 120%+ achievement — flagged for review</div>';

  var hasActuals = scGoals.some(function(g){ return g.scActual!==''&&g.scActual!==null&&g.scActual!==undefined; });
  if (hasActuals) {
    html += '<div style="font-size:9px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;font-family:var(--mono);margin-bottom:6px;">GOAL BREAKDOWN</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:11px;font-family:var(--mono);">';
    html += '<tr style="background:var(--surface2);"><th style="padding:5px 8px;text-align:left;font-size:9px;font-weight:700;color:var(--text-muted);">Goal</th><th style="padding:5px 8px;text-align:right;font-size:9px;font-weight:700;color:var(--text-muted);">Weight</th><th style="padding:5px 8px;text-align:right;font-size:9px;font-weight:700;color:var(--text-muted);">Actual</th><th style="padding:5px 8px;text-align:right;font-size:9px;font-weight:700;color:var(--text-muted);">Achieve%</th><th style="padding:5px 8px;text-align:right;font-size:9px;font-weight:700;color:var(--text-muted);">Weighted</th><th style="padding:5px 8px;text-align:right;font-size:9px;font-weight:700;color:var(--text-muted);">Bonus $</th></tr>';
    scGoals.forEach(function(g) {
      var actual = (g.scActual!==''&&g.scActual!==null&&g.scActual!==undefined) ? parseFloat(g.scActual) : null;
      var ach=null, weighted=null, bonusC=0, belowMin=false;
      if (actual!==null && g.scTarget) {
        var lb = g.lowerBetter!==false;
        var minV = parseFloat(g.minValue);
        if (!isNaN(minV)) {
          var metMin = lb ? (actual <= minV) : (actual >= minV);
          if (!metMin) { belowMin=true; ach=0; weighted=0; bonusC=0; }
        }
        if (!belowMin) {
          ach = lb ? (parseFloat(g.scTarget)/actual)*100 : (actual/parseFloat(g.scTarget))*100;
          if (g.capped==='yes') ach = Math.min(ach, parseFloat(g.capPct)||100);
          weighted = ach*(parseFloat(g.scWeight)||0)/100;
          bonusC = earnings*(weighted/100)*0.1;
        }
      }
      var achStr = belowMin ? 'Below min' : (ach!==null ? ach.toFixed(1)+'%' : '—');
      var wStr   = belowMin ? '0%' : (weighted!==null ? weighted.toFixed(1)+'%' : '—');
      var bStr   = belowMin ? '$0.00' : (bonusC ? '$'+bonusC.toFixed(2) : '—');
      var achCol = belowMin ? '#9B2C2C' : (ach!==null ? (ach>=100?'#2D6B1A':'#703c2e') : 'var(--text-muted)');
      html += '<tr style="border-bottom:1px solid var(--border);">'+
        '<td style="padding:5px 8px;">'+escAttr(g.name||'')+'</td>'+
        '<td style="padding:5px 8px;text-align:right;color:var(--text-muted);">'+(parseFloat(g.scWeight)||0)+'%</td>'+
        '<td style="padding:5px 8px;text-align:right;">'+escAttr(String(actual!==null?actual:'—'))+'</td>'+
        '<td style="padding:5px 8px;text-align:right;font-weight:700;color:'+achCol+';">'+achStr+'</td>'+
        '<td style="padding:5px 8px;text-align:right;color:var(--text-muted);">'+wStr+'</td>'+
        '<td style="padding:5px 8px;text-align:right;font-weight:600;color:var(--brick);">'+bStr+'</td>'+
      '</tr>';
    });
    html += '</table>';
  }
  summary.innerHTML = html;
}

function scRemoveGoal(i) {
  scGoals.splice(i, 1);
  scRender();
  scRenderBankPicker(JSON.parse(localStorage.getItem(BANK_KEY)||'[]'),
    document.getElementById('sc-dept').value,
    document.getElementById('sc-loc').value,
    document.getElementById('sc-role').value);
}

async function scSubmit() {
  var name     = document.getElementById('sc-name').value.trim();
  var role     = document.getElementById('sc-role').value.trim();
  var dept     = document.getElementById('sc-dept').value.trim();
  var loc      = document.getElementById('sc-loc').value.trim();
  var manager  = document.getElementById('sc-manager').value.trim();
  var month    = scGetPeriodLabel();
  var payType  = document.getElementById('sc-paytype').value;
  var rate     = parseFloat(document.getElementById('sc-rate').value)||0;
  var hours    = parseFloat(document.getElementById('sc-hours').value)||0;
  var earnings = parseFloat(document.getElementById('sc-earnings').value)||0;

  if (!name)     { showToast('Employee name required', 'error'); return; }
  if (!month)    { showToast('Select a scorecard period', 'error'); return; }
  if (!earnings) { showToast('Base earnings required', 'error'); return; }
  if (!scGoals.length) { showToast('Add at least one goal', 'error'); return; }

  var totalWeight = scGoals.reduce(function(s,g){return s+(parseFloat(g.scWeight)||0);},0);
  if (Math.abs(totalWeight-100)>0.01) { showToast('Weights must total 100% (currently '+totalWeight.toFixed(0)+'%)', 'error'); return; }

  // Check all individual goals have names
  for (var i=0;i<scGoals.length;i++) {
    if (!scGoals[i].name) { showToast('All goals need a name', 'error'); return; }
  }

  // Check all actuals are filled in
  var missingActuals = scGoals.filter(function(g) {
    return g.scActual===''||g.scActual===null||g.scActual===undefined;
  });
  if (missingActuals.length > 0) {
    showToast('Please enter actuals for all ' + missingActuals.length + ' goal(s) before submitting', 'error');
    return;
  }

  // Check base earnings is set
  var earningsEl = document.getElementById('sc-earnings');
  if (!earningsEl || !earningsEl.value || parseFloat(earningsEl.value) <= 0) {
    showToast('Please enter base earnings before submitting', 'error');
    return;
  }

  var period = formatMonthLabel(month);
  var goals = scGoals.map(function(g) {
    var actual = g.scActual!==''&&g.scActual!==null?parseFloat(g.scActual):null;
    var lb = g.lowerBetter!==false;
    var ach = 0;
    if (actual && g.scTarget) {
      var minV = parseFloat(g.minValue);
      var metMin = isNaN(minV) || (lb ? actual <= minV : actual >= minV);
      if (metMin) {
        ach = lb ? (parseFloat(g.scTarget)/actual)*100 : (actual/parseFloat(g.scTarget))*100;
        if (g.capped==='yes') ach = Math.min(ach, parseFloat(g.capPct)||100);
      }
    }
    return {
      name:g.name, goalTier:g.goalTier||'individual',
      weight:parseFloat(g.scWeight)||0, goalValue:parseFloat(g.scTarget)||0,
      minValue:parseFloat(g.minValue)||0, lowerBetter:lb,
      capped:g.capped, capPct:parseFloat(g.capPct)||100,
      actualValue:actual, achievement:ach,
      department:g.department||'', role:g.role||''
    };
  });

  var weightedAch = goals.reduce(function(s,g){return s+(g.achievement*g.weight/100);},0);
  var capped = weightedAch > 200;
  var achFinal = capped ? 200 : weightedAch;
  var bonus = parseFloat((earnings*(achFinal/100)*0.1).toFixed(2));

  var payload = {
    employeeName:name, role:role, department:dept, location:loc,
    manager:manager, payType:payType, hourlyRate:rate, hours:hours,
    annualPay:payType==='salary'?rate:0,
    baseEarnings:earnings, bonusPotentialPct:10,
    scorecardMonth:period, weightedAchievement:achFinal,
    bonusAmount:bonus, scorecardCapped:capped,
    flag120:(!capped&&achFinal>=120),
    goals:goals, submittedAt:new Date().toISOString()
  };

  if (sb && currentUser) {
    var sbResult = await sbSaveScorecard(payload);
    if (sbResult && sbResult.error) { showToast('Error: '+sbResult.error.message, 'error'); return; }
  } else {
    await apiSaveScorecard(payload);
  }
  showToast('Scorecard submitted for '+name+'!', 'success');

  // Reset form
  scGoals = [];
  scEmployee = null;
  ['sc-name','sc-role','sc-dept','sc-loc','sc-rate','sc-hours','sc-earnings','sc-manager','sc-paytype-display'].forEach(function(id){
    var el=document.getElementById(id); if(el) el.value='';
  });
  var scMonthEl = document.getElementById('sc-month'); if(scMonthEl) scMonthEl.value='';
  document.getElementById('sc-goals-section').style.display='none';
  document.getElementById('sc-add-goals-section').style.display='none';
  document.getElementById('sc-submit-section').style.display='none';
}

function clearAllRipplingData() {
  if (!confirm('Clear all saved Rippling data? This cannot be undone.')) return;
  // Remove all rippling: keys from localStorage
  var keysToRemove = [];
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && k.indexOf('rippling:') === 0) keysToRemove.push(k);
  }
  keysToRemove.push('rippling-months-index');
  keysToRemove.forEach(function(k) { localStorage.removeItem(k); });
  showToast('All Rippling data cleared', 'success');
  loadRipplingSaved();
}

async function runMigration() {
  if (!sb || !currentUser) { showToast('Must be signed in to migrate', 'error'); return; }
  var status = document.getElementById('migrate-status');
  var log = function(msg) { status.innerHTML += msg + '<br>'; };
  status.innerHTML = '';
  log('Starting migration...');

  // 1. Migrate Goal Bank
  try {
    var raw = localStorage.getItem('goal-bank-v1');
    var goals = raw ? JSON.parse(raw) : [];
    if (goals.length) {
      log('Found ' + goals.length + ' goals in Goal Bank...');
      for (var i = 0; i < goals.length; i++) {
        var g = goals[i];
        var row = {
          goal_tier: g.goalTier||'individual', location: g.location||null,
          department: g.department||null, role: g.role||null, name: g.name,
          goal_value: g.goalValue, min_value: g.minValue,
          lower_better: g.lowerBetter!==false, capped: g.capped||'no',
          cap_pct: g.capPct||100, active: g.active!==false
        };
        await sb.from('goals_bank').upsert(row, {onConflict: 'name,goal_tier,department,location,role'}).catch(function(){});
      }
      log('✓ Migrated ' + goals.length + ' goals');
    } else { log('No goals found in localStorage'); }
  } catch(e) { log('✗ Goal Bank error: ' + e.message); }

  // 2. Migrate Actuals
  try {
    var actualsCount = 0;
    for (var k = 0; k < localStorage.length; k++) {
      var key = localStorage.key(k);
      if (key && key.indexOf('actuals-v1:') === 0) {
        var month = key.replace('actuals-v1:', '');
        var actData = JSON.parse(localStorage.getItem(key));
        for (var goalKey in actData) {
          var parts = goalKey.split('|');
          var row2 = {
            period: month, goal_tier: parts[0], location: parts[1]||null,
            department: parts[2]||null, goal_name: parts[3],
            actual_value: actData[goalKey]
          };
          await sb.from('actuals').upsert(row2, {onConflict: 'period,goal_tier,location,department,goal_name'}).catch(function(){});
          actualsCount++;
        }
      }
    }
    log('✓ Migrated ' + actualsCount + ' actuals entries');
  } catch(e) { log('✗ Actuals error: ' + e.message); }

  // 3. Migrate Scorecards
  try {
    var scCount = 0;
    for (var k2 = 0; k2 < localStorage.length; k2++) {
      var key2 = localStorage.key(k2);
      if (key2 && key2.indexOf('scorecards:') === 0) {
        var period2 = key2.replace('scorecards:', '');
        var scs = JSON.parse(localStorage.getItem(key2));
        for (var si = 0; si < scs.length; si++) {
          var sc = scs[si];
          var row3 = {
            employee_name: sc.employeeName, role: sc.role, department: sc.department,
            location: sc.location, manager: sc.manager, pay_type: sc.payType,
            hourly_rate: sc.hourlyRate||null, hours_worked: sc.hours||null,
            base_earnings: sc.baseEarnings, bonus_potential_pct: sc.bonusPotentialPct||10,
            scorecard_month: sc.scorecardMonth||period2, period_type: sc.scorecardPeriodType||'monthly',
            weighted_achievement: sc.weightedAchievement, bonus_amount: sc.bonusAmount,
            scorecard_capped: sc.scorecardCapped||false, flag_120: sc.flag120||false,
            goals: sc.goals, submitted_at: sc.submittedAt||new Date().toISOString()
          };
          await sb.from('scorecards').insert(row3).catch(function(){});
          scCount++;
        }
      }
    }
    log('✓ Migrated ' + scCount + ' scorecards');
  } catch(e) { log('✗ Scorecards error: ' + e.message); }

  // 4. Migrate Rippling data
  try {
    var ripCount = 0;
    for (var k3 = 0; k3 < localStorage.length; k3++) {
      var key3 = localStorage.key(k3);
      if (key3 && key3.indexOf('rippling:') === 0) {
        var rMonth = key3.replace('rippling:', '');
        var emps = JSON.parse(localStorage.getItem(key3));
        await sbSaveRippling(rMonth, emps).catch(function(){});
        ripCount += emps.length;
      }
    }
    log('✓ Migrated ' + ripCount + ' Rippling employee records');
  } catch(e) { log('✗ Rippling error: ' + e.message); }

  log('<strong>Migration complete!</strong> Refresh the page to see your data.');
  showToast('Migration complete!', 'success');
}

function sendGoalPayload(payload) {
  if (!payload) return;
  apiSaveGoals(payload).then(function() {
    var btn = document.getElementById('setup-submit-btn');
    btn.disabled = false;
    btn.textContent = goalTier === 'company' ? 'Save Company Goals' : goalTier === 'department' ? 'Save Department Goals' : 'Save Individual Goals';
    pendingGoalPayload = null;
    setupGoals = [];
    renderSetupGoals();
    showToast('Goals saved!', 'success');
    loadSavedGoalsPreview();
    loadSetupTierGoalPreviews();
    loadSetupPeriodOverview();
  }).catch(function() {
    showToast('Save failed', 'error');
  });
}

window.onload = function() { try {
  // Guard all old setup elements — they no longer exist in the new layout
  function wire(id, event, fn) { var el = document.getElementById(id); if (el) el.addEventListener(event, fn); }
  wire('setup-period-monthly', 'click', function() { setSetupPeriod('monthly'); });
  wire('setup-period-quarterly', 'click', function() { setSetupPeriod('quarterly'); });
  wire('actuals-period-monthly', 'click', function() { setActualsPeriod('monthly'); });
  wire('actuals-period-quarterly', 'click', function() { setActualsPeriod('quarterly'); });
  wire('setup-add-goal-btn', 'click', function() { addSetupGoal(); });
  wire('add-goal-btn', 'click', function() { addGoal(); });
  wire('setup-location', 'change', function() { loadSetupPresetGoals(); loadSavedGoalsPreview(); loadSetupTierGoalPreviews(); loadSetupPeriodOverview(); });
  wire('setup-submit-btn', 'click', submitGoalSetup);

  // Old actuals/setup elements — guard all
  wire('emp-location', 'change', function() { onActualsContextChange(); loadSubmittedScorecardsPreview(); });
  wire('emp-dept', 'change', function() { onActualsContextChange(); loadSubmittedScorecardsPreview(); });
  wire('emp-month', 'change', function() { onActualsContextChange(); loadSubmittedScorecardsPreview(); });
  wire('emp-role', 'change', onRoleChange);
  wire('submit-btn', 'click', submitToSheet);
  wire('bonusPot', 'input', calc);
  wire('overwrite-confirm-btn', 'click', function() {
    var m = document.getElementById('overwrite-modal'); if(m) m.style.display='none';
    if(pendingGoalPayload) doSaveGoals(); else showToast('Nothing to save','error');
  });
  wire('overwrite-cancel-btn', 'click', function() {
    var m = document.getElementById('overwrite-modal'); if(m) m.style.display='none';
    pendingGoalPayload=null;
  });
  wire('duplicate-confirm-btn', 'click', function() {
    var m = document.getElementById('duplicate-modal'); if(m) m.style.display='none';
    doSubmitActuals();
  });
  wire('duplicate-cancel-btn', 'click', function() {
    var m = document.getElementById('duplicate-modal'); if(m) m.style.display='none';
    pendingActualsPayload=null; showToast('Cancelled','');
  });

  var now = new Date();
  var monthStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  var minDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  var minStr = minDate.getFullYear() + '-' + String(minDate.getMonth()+1).padStart(2,'0');

  function setMonth(id, val, max, min) {
    var el = document.getElementById(id);
    if (!el) return;
    if (val !== undefined) el.value = val;
    if (max !== undefined) el.max = max;
    if (min !== undefined) el.min = min;
  }
  setMonth('emp-month', monthStr, monthStr, minStr);
  setMonth('setup-month', '', null, minStr);
  setMonth('ta-month', monthStr, monthStr, minStr);
  setMonth('ca-month', monthStr, monthStr, minStr);

  var addSetupGoalFn = document.getElementById('setup-goals-container') ? addSetupGoal : null;
  if (addSetupGoalFn) addSetupGoalFn();
  if (document.getElementById('submitted-scorecards-section')) loadSubmittedScorecardsPreview();

  setMonth('sc-month', monthStr, monthStr, minStr);
  // Init Supabase then load data
  initSupabase();
  // Show any cached badge immediately on every load
  updateUserBadge();
  setInterval(updateUserBadge, 3000); // keep badge fresh
  // Data loads are triggered by auth state change — also load locally if no auth yet
  bankLoad();
  actLoad();
  // Init pay type display
  var scPayDisplay = document.getElementById('sc-paytype-display');
  if (scPayDisplay) scPayDisplay.value = 'Hourly';

  // Init rippling month
  var ripplingMonthEl = document.getElementById('rippling-month');
  if (ripplingMonthEl) ripplingMonthEl.value = monthStr;

  // Init actuals month
  setMonth('act-month', monthStr, monthStr, minStr);
  setMonth('act2-month', monthStr, monthStr, minStr);

  // History tab starts blank — user must search
  var overviewYearEl = document.getElementById('overview-year');
  if (overviewYearEl) overviewYearEl.value = String(now.getFullYear());
} catch(e) { console.error('onload error at:', e.message, e.stack); } };

(function guardLegacyOnload() {
  var legacyOnload = window.onload;
  if (typeof legacyOnload !== 'function') return;
  window.onload = function(event) {
    if (window.__pfLegacyBootstrapped) return;
    window.__pfLegacyBootstrapped = true;
    return legacyOnload.call(window, event);
  };
  if (document.readyState !== 'loading') {
    setTimeout(function() { window.onload(); }, 0);
  }
})();

