'use strict';
/* ==========================================================================
   EXAMINAR — Exam System
   Vanilla ES6 modular architecture. No frameworks, no external libraries.
   Sections:
     1. Utils
     2. Storage
     3. QuestionBank
     4. StatsStore
     5. ExamSession
     6. i18n
     7. App (UI controller / event wiring)
   ========================================================================== */

/* ==========================================================================
   1. UTILS
   ========================================================================== */
const Utils = {
  uid(prefix = 'q'){
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  },
  shuffle(arr){
    // Fisher-Yates — returns a new array, does not mutate the original
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },
  formatTime(totalSeconds){
    const s = Math.max(0, Math.round(totalSeconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  },
  escapeHtml(str = ''){
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
  clamp(n, min, max){ return Math.min(max, Math.max(min, n)); },
  debounce(fn, wait = 200){
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  }
};

/* ==========================================================================
   2. STORAGE — thin LocalStorage wrapper, single source of truth for keys
   ========================================================================== */
const STORAGE_KEYS = {
  QUESTIONS: 'examinar_questions_v1',
  STATS: 'examinar_stats_v1',
  HISTORY: 'examinar_history_v1',
  SETTINGS: 'examinar_settings_v1'
};

const Storage = {
  get(key, fallback = null){
    try{
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    }catch(e){
      console.warn('Storage read failed for', key, e);
      return fallback;
    }
  },
  set(key, value){
    try{
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    }catch(e){
      console.warn('Storage write failed for', key, e);
      return false;
    }
  },
  remove(key){ localStorage.removeItem(key); }
};

/* ==========================================================================
   3. QUESTION BANK — CRUD + search + import/export
   ========================================================================== */
class QuestionBank{
  constructor(){
    // Only seed on the very first run ever (storage key never set). Once the
    // user has a bank of their own — even an empty one after deleting
    // everything — we respect that and never re-inject sample data.
    const stored = Storage.get(STORAGE_KEYS.QUESTIONS, null);
    if (stored === null){
      this.questions = [];
      this.persist();
    } else {
      this.questions = stored;
    }
  }

  persist(){ Storage.set(STORAGE_KEYS.QUESTIONS, this.questions); }

  all(){ return this.questions; }

  count(){ return this.questions.length; }

  getById(id){ return this.questions.find(q => q.id === id); }

  add(question){
    const q = { ...question, id: Utils.uid('q') };
    this.questions.push(q);
    this.persist();
    return q;
  }

  update(id, patch){
    const idx = this.questions.findIndex(q => q.id === id);
    if (idx === -1) return null;
    this.questions[idx] = { ...this.questions[idx], ...patch, id };
    this.persist();
    return this.questions[idx];
  }

  delete(id){
    this.questions = this.questions.filter(q => q.id !== id);
    this.persist();
  }

  duplicate(id){
    const src = this.getById(id);
    if (!src) return null;
    const copy = { ...src, id: Utils.uid('q'), text: src.text + ' (copy)' };
    this.questions.push(copy);
    this.persist();
    return copy;
  }

  categories(){
    return [...new Set(this.questions.map(q => q.category).filter(Boolean))].sort();
  }

  search(term = '', category = '', difficulty = ''){
    const t = term.trim().toLowerCase();
    return this.questions.filter(q => {
      const matchesTerm = !t ||
        q.text.toLowerCase().includes(t) ||
        (q.category || '').toLowerCase().includes(t) ||
        (q.difficulty || '').toLowerCase().includes(t);
      const matchesCategory = !category || q.category === category;
      const matchesDifficulty = !difficulty || q.difficulty === difficulty;
      return matchesTerm && matchesCategory && matchesDifficulty;
    });
  }

  exportJSON(){
    return JSON.stringify(this.questions, null, 2);
  }

  importJSON(jsonText){
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) throw new Error('JSON must be an array of questions');
    let imported = 0;
    parsed.forEach(raw => {
      if (!raw.text || !Array.isArray(raw.choices)) return;
      this.questions.push({
        id: Utils.uid('q'),
        text: raw.text,
        image: raw.image || '',
        choices: raw.choices.map(c => (typeof c === 'string' ? { id: Utils.uid('c'), text: c, correct: false } : { id: c.id || Utils.uid('c'), text: c.text, correct: !!c.correct })),
        timer: raw.timer || 30,
        difficulty: raw.difficulty || 'Medium',
        category: raw.category || 'General',
        explanation: raw.explanation || ''
      });
      imported++;
    });
    this.persist();
    return imported;
  }

}

/* ==========================================================================
   4. STATS STORE — persistent all-time statistics + history
   ========================================================================== */
class StatsStore{
  constructor(){
    this.stats = Storage.get(STORAGE_KEYS.STATS, {
      highestScore: 0, lastScore: 0, averageScore: 0,
      totalAttempts: 0, bestPercentage: 0, bestTime: null, lastAttemptDate: null
    });
    this.history = Storage.get(STORAGE_KEYS.HISTORY, []);
  }

  recordAttempt(result){
    const { correct, total, percentage, totalTimeSeconds } = result;
    const s = this.stats;
    s.lastScore = correct;
    s.highestScore = Math.max(s.highestScore, correct);
    s.totalAttempts += 1;
    s.averageScore = Math.round(((s.averageScore * (s.totalAttempts - 1)) + correct) / s.totalAttempts * 10) / 10;
    s.bestPercentage = Math.max(s.bestPercentage, percentage);
    if (s.bestTime === null || totalTimeSeconds < s.bestTime) s.bestTime = totalTimeSeconds;
    s.lastAttemptDate = new Date().toISOString();

    this.history.unshift({
      date: s.lastAttemptDate, correct, total, percentage,
      totalTimeSeconds, wrong: result.wrong, unanswered: result.unanswered
    });
    this.history = this.history.slice(0, 50);

    Storage.set(STORAGE_KEYS.STATS, s);
    Storage.set(STORAGE_KEYS.HISTORY, this.history);
  }

  resetAll(){
    this.stats = { highestScore: 0, lastScore: 0, averageScore: 0, totalAttempts: 0, bestPercentage: 0, bestTime: null, lastAttemptDate: null };
    this.history = [];
    Storage.set(STORAGE_KEYS.STATS, this.stats);
    Storage.set(STORAGE_KEYS.HISTORY, this.history);
  }
}

/* ==========================================================================
   5. EXAM SESSION — owns the live attempt: order, timers, scoring, flags
   ========================================================================== */
class ExamSession{
  constructor(questions, { mode = 'exam', soundEnabled = true } = {}){
    // Randomize question order — every attempt gets a fresh sequence
    this.queue = Utils.shuffle(questions).map(q => ({
      ...q,
      // Randomize answer order while preserving which choice is correct
      choices: Utils.shuffle(q.choices)
    }));
    this.mode = mode; // 'exam' | 'practice' | 'incorrect'
    this.soundEnabled = soundEnabled;
    this.index = 0;
    this.answers = []; // { questionId, chosenId, correct, timeUsed, status }
    this.warningCount = 0;
    this.flags = new Set();
    this.startedAt = Date.now();
    this.paused = false;
    this.timeLeft = this.currentQuestion() ? this.currentQuestion().timer : 0;
    this._tickHandle = null;
    this.onTick = null;
    this.onAdvance = null;
    this.onFinish = null;
  }

  currentQuestion(){ return this.queue[this.index] || null; }
  total(){ return this.queue.length; }
  answeredCount(){ return this.answers.length; }
  remainingCount(){ return this.total() - this.answeredCount(); }
  correctCount(){ return this.answers.filter(a => a.status === 'correct').length; }
  percentage(){ return this.total() ? Math.round((this.correctCount() / this.total()) * 100) : 0; }
  elapsedSeconds(){ return (Date.now() - this.startedAt) / 1000; }

  startQuestionTimer(){
    const q = this.currentQuestion();
    if (!q) return;
    this.timeLeft = this.mode === 'practice' ? q.timer * 3 : q.timer; // practice mode gives generous time, still ticks
    this._questionStartedAt = Date.now();
    if (this.onTick) this.onTick(this.timeLeft, q.timer); // sync the display the instant the question appears
    clearInterval(this._tickHandle);
    this._tickHandle = setInterval(() => {
      if (this.paused) return;
      this.timeLeft -= 1;
      if (this.onTick) this.onTick(this.timeLeft, q.timer);
      if (this.timeLeft <= 0){
        this.submitAnswer(null, true);
      }
    }, 1000);
  }

  stopTimer(){ clearInterval(this._tickHandle); }

  pause(){ this.paused = true; }
  resume(){ this.paused = false; }

  toggleFlag(){
    const q = this.currentQuestion();
    if (!q) return false;
    if (this.flags.has(q.id)) this.flags.delete(q.id); else this.flags.add(q.id);
    return this.flags.has(q.id);
  }

  registerWarning(){ this.warningCount += 1; }

  /** Records an answer for the current question and fires onAdvance after a short delay. */
  submitAnswer(choiceId, timedOut = false){
    const q = this.currentQuestion();
    if (!q) return;
    this.stopTimer();
    const timeUsed = Math.round((Date.now() - this._questionStartedAt) / 1000);
    const chosen = choiceId ? q.choices.find(c => c.id === choiceId) : null;
    let status;
    if (timedOut || !chosen){ status = 'unanswered'; }
    else { status = chosen.correct ? 'correct' : 'wrong'; }

    this.answers.push({
      questionId: q.id,
      chosenId: choiceId || null,
      status,
      timeUsed,
      flagged: this.flags.has(q.id)
    });

    if (this.onAdvance) this.onAdvance(status, choiceId || null);
  }

  goNext(){
    this.index += 1;
    if (this.index >= this.total()){
      this.stopTimer();
      if (this.onFinish) this.onFinish(this.computeResults());
      return false;
    }
    this.startQuestionTimer();
    return true;
  }

  computeResults(){
    const correct = this.answers.filter(a => a.status === 'correct').length;
    const wrong = this.answers.filter(a => a.status === 'wrong').length;
    const unanswered = this.answers.filter(a => a.status === 'unanswered').length;
    const total = this.total();
    const percentage = total ? Math.round((correct / total) * 100) : 0;
    const totalTimeSeconds = Math.round(this.elapsedSeconds());
    const avgTime = total ? Math.round((totalTimeSeconds / total) * 10) / 10 : 0;
    let grade;
    if (percentage >= 90) grade = 'Excellent';
    else if (percentage >= 75) grade = 'Very Good';
    else if (percentage >= 60) grade = 'Good';
    else if (percentage >= 50) grade = 'Pass';
    else grade = 'Fail';

    return { correct, wrong, unanswered, total, percentage, totalTimeSeconds, avgTime, grade, warningCount: this.warningCount };
  }

  /** Builds the full review trail in presentation order, with correct/user answers resolved. */
  buildReview(){
    return this.queue.map((q, i) => {
      const a = this.answers[i];
      return {
        question: q,
        chosenId: a ? a.chosenId : null,
        status: a ? a.status : 'unanswered',
        timeUsed: a ? a.timeUsed : q.timer,
        flagged: a ? a.flagged : this.flags.has(q.id)
      };
    });
  }
}

/* ==========================================================================
   6. I18N — minimal English / Arabic dictionary for RTL support
   ========================================================================== */
const I18N = {
  en: {
    bank: 'Question Bank', stats: 'Statistics', newQuestion: 'New Question', editQuestion: 'Edit Question',
    startExam: 'Start Exam', addQuestion: 'Add Question', saveChanges: 'Save Changes'
  },
  ar: {
    bank: 'بنك الأسئلة', stats: 'الإحصائيات', newQuestion: 'سؤال جديد', editQuestion: 'تعديل السؤال',
    startExam: 'ابدأ الامتحان', addQuestion: 'إضافة سؤال', saveChanges: 'حفظ التعديلات'
  }
};

/* ==========================================================================
   7. APP — UI controller: DOM wiring, view routing, rendering
   ========================================================================== */
class App{
  constructor(){
    this.bank = new QuestionBank();
    this.stats = new StatsStore();
    this.session = null;
    this.lang = 'en';
    this.editingChoices = []; // working array while the question form is open
    this.reviewIncorrectOnly = false;

    this.cacheDom();
    this.bindGlobalEvents();
    this.bindAdminEvents();
    this.bindExamEvents();
    this.bindResultsEvents();
    this.bindReviewEvents();
    this.applyStoredTheme();
    this.resetChoiceForm();
    this.renderQuestionList();
    this.renderFilters();
    this.renderStats();
    this.refreshStartButton();
  }

  cacheDom(){
    this.$ = (id) => document.getElementById(id);
    this.views = document.querySelectorAll('.view');
    this.navTabs = document.querySelectorAll('.navtab');
  }

  /* ---------------- View routing ---------------- */
  showView(name){
    document.querySelectorAll('.view').forEach(v => v.classList.remove('is-active'));
    this.$(`view-${name}`).classList.add('is-active');
    this.navTabs.forEach(t => t.classList.toggle('is-active', t.dataset.view === name));
  }

  /* ---------------- Global events (theme, lang, nav) ---------------- */
  bindGlobalEvents(){
    this.navTabs.forEach(tab => tab.addEventListener('click', () => {
      this.showView(tab.dataset.view);
      if (tab.dataset.view === 'stats') this.renderStats();
    }));

    this.$('themeToggle').addEventListener('click', () => {
      document.body.classList.toggle('light-theme');
      const isLight = document.body.classList.contains('light-theme');
      this.$('themeToggle').textContent = isLight ? '☀' : '☾';
      Storage.set(STORAGE_KEYS.SETTINGS, { ...Storage.get(STORAGE_KEYS.SETTINGS, {}), light: isLight });
    });

    this.$('langToggle').addEventListener('click', () => {
      this.lang = this.lang === 'en' ? 'ar' : 'en';
      const html = document.documentElement;
      html.dir = this.lang === 'ar' ? 'rtl' : 'ltr';
      html.lang = this.lang;
      this.toast(this.lang === 'ar' ? 'تم تفعيل الوضع من اليمين لليسار' : 'Switched to left-to-right layout');
    });

    // Anti-cheat: block context menu, selection, clipboard, drag globally
    document.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('copy', e => e.preventDefault());
    document.addEventListener('cut', e => e.preventDefault());
    document.addEventListener("paste", (e) => {     if (!this.isExamActive()) return;      const tag = e.target.tagName;     if (tag === "INPUT" || tag === "TEXTAREA") return;      e.preventDefault(); });
    document.addEventListener('dragstart', e => e.preventDefault());
    document.addEventListener('selectstart', e => {
      // still allow selection inside editable inputs/textareas
      const tag = e.target.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.preventDefault();
    });

    window.addEventListener('beforeunload', (e) => {
      if (this.session && !this.session.paused && this.$('view-exam').classList.contains('is-active')){
        e.preventDefault();
        e.returnValue = 'Your exam is still running. Are you sure you want to leave?';
        return e.returnValue;
      }
    });
  }

  applyStoredTheme(){
    const settings = Storage.get(STORAGE_KEYS.SETTINGS, {});
    if (settings.light){
      document.body.classList.add('light-theme');
      this.$('themeToggle').textContent = '☀';
    }
  }

  toast(msg, ms = 2600){
    const t = this.$('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  /* ======================================================================
     ADMIN VIEW — question form, list, search/filter, import/export
     ====================================================================== */
  bindAdminEvents(){
    this.$('addChoiceBtn').addEventListener('click', () => this.addChoiceRow());
    this.$('questionForm').addEventListener('submit', (e) => this.handleSaveQuestion(e));
    this.$('cancelEditBtn').addEventListener('click', () => this.resetChoiceForm());

    this.$('searchBox').addEventListener('input', Utils.debounce(() => this.renderQuestionList(), 150));
    this.$('filterCategory').addEventListener('change', () => this.renderQuestionList());
    this.$('filterDifficulty').addEventListener('change', () => this.renderQuestionList());

    this.$('exportBtn').addEventListener('click', () => this.exportQuestions());
    this.$('importFile').addEventListener('change', (e) => this.importQuestions(e));
    this.$('resetDataBtn').addEventListener('click', () => this.resetAllData());

    this.$('startExamBtn').addEventListener('click', () => this.launchExam());
    this.$('examCategory').addEventListener('focus', () => this.renderFilters());
  }

  resetChoiceForm(){
    this.$('questionForm').reset();
    this.$('questionId').value = '';
    this.$('formTitle').textContent = 'New Question';
    this.$('saveQuestionBtn').textContent = 'Add Question';
    this.$('cancelEditBtn').hidden = true;
    this.editingChoices = [
      { id: Utils.uid('c'), text: '', correct: true },
      { id: Utils.uid('c'), text: '', correct: false },
      { id: Utils.uid('c'), text: '', correct: false },
      { id: Utils.uid('c'), text: '', correct: false }
    ];
    this.renderChoiceRows();
  }

  addChoiceRow(){
    this.editingChoices.push({ id: Utils.uid('c'), text: '', correct: false });
    this.renderChoiceRows();
  }

  renderChoiceRows(){
    const wrap = this.$('choicesList');
    wrap.innerHTML = '';
    this.editingChoices.forEach((choice, i) => {
      const row = document.createElement('div');
      row.className = 'choice-row';
      row.innerHTML = `
        <button type="button" class="correct-dot ${choice.correct ? 'is-correct' : ''}" data-id="${choice.id}" title="Mark correct" aria-label="Mark as correct answer"></button>
        <input type="text" value="${Utils.escapeHtml(choice.text)}" data-id="${choice.id}" placeholder="Choice ${i + 1}">
        <button type="button" class="choice-remove" data-id="${choice.id}" title="Remove choice">&times;</button>
      `;
      wrap.appendChild(row);
    });

    wrap.querySelectorAll('.correct-dot').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      this.editingChoices = this.editingChoices.map(c => ({ ...c, correct: c.id === id }));
      this.renderChoiceRows();
    }));
    wrap.querySelectorAll('.choice-row input[type=text]').forEach(inp => inp.addEventListener('input', () => {
      const c = this.editingChoices.find(c => c.id === inp.dataset.id);
      if (c) c.text = inp.value;
    }));
    wrap.querySelectorAll('.choice-remove').forEach(btn => btn.addEventListener('click', () => {
      if (this.editingChoices.length <= 2){ this.toast('A question needs at least 2 choices'); return; }
      this.editingChoices = this.editingChoices.filter(c => c.id !== btn.dataset.id);
      if (!this.editingChoices.some(c => c.correct)) this.editingChoices[0].correct = true;
      this.renderChoiceRows();
    }));
  }

  handleSaveQuestion(e){
    e.preventDefault();
    const text = this.$('qText').value.trim();
    const category = this.$('qCategory').value.trim();
    const difficulty = this.$('qDifficulty').value;
    const timer = parseInt(this.$('qTimer').value, 10) || 30;
    const image = this.$('qImage').value.trim();
    const explanation = this.$('qExplanation').value.trim();
    const choices = this.editingChoices.filter(c => c.text.trim() !== '');

    if (!text || choices.length < 2){
      this.toast('Add a question and at least 2 non-empty choices');
      return;
    }
    if (!choices.some(c => c.correct)) choices[0].correct = true;

    const payload = { text, category, difficulty, timer, image, explanation, choices };
    const id = this.$('questionId').value;

    if (id){
      this.bank.update(id, payload);
      this.toast('Question updated');
    } else {
      this.bank.add(payload);
      this.toast('Question added');
    }

    this.resetChoiceForm();
    this.renderQuestionList();
    this.renderFilters();
    this.refreshStartButton();
  }

  renderFilters(){
    const cats = this.bank.categories();
    const build = (selectEl, includeAll) => {
      const current = selectEl.value;
      selectEl.innerHTML = includeAll ? '<option value="">All categories</option>' : '';
      cats.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c; opt.textContent = c;
        selectEl.appendChild(opt);
      });
      if (cats.includes(current)) selectEl.value = current;
    };
    build(this.$('filterCategory'), true);
    build(this.$('examCategory'), true);

    // Category combobox in the question form: suggest existing categories
    // but still let the person type a brand new one freely.
    const datalist = this.$('categoryOptions');
    datalist.innerHTML = '';
    cats.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      datalist.appendChild(opt);
    });
  }

  renderQuestionList(){
    const term = this.$('searchBox').value;
    const cat = this.$('filterCategory').value;
    const diff = this.$('filterDifficulty').value;
    const results = this.bank.search(term, cat, diff);
    const list = this.$('questionListEl');
    list.innerHTML = '';

    this.$('questionCount').textContent = this.bank.count();

    if (results.length === 0){
      list.innerHTML = '<div class="empty-state">No questions match. Try a different search or add one.</div>';
      return;
    }

    // Efficient render: build one HTML string then attach delegated listeners once
    const frag = document.createDocumentFragment();
    results.forEach(q => {
      const card = document.createElement('div');
      card.className = 'qcard';
      card.setAttribute('role', 'listitem');
      const diffClass = q.difficulty === 'Easy' ? 'tag--easy' : q.difficulty === 'Hard' ? 'tag--hard' : 'tag--medium';
      card.innerHTML = `
        <div class="qcard__top">
          <div class="qcard__text">${Utils.escapeHtml(q.text)}</div>
          <div class="qcard__actions">
            <button data-act="edit" title="Edit">✎</button>
            <button data-act="dup" title="Duplicate">⧉</button>
            <button data-act="del" title="Delete">🗑</button>
          </div>
        </div>
        <div class="qcard__tags">
          <span class="tag">${Utils.escapeHtml(q.category || 'General')}</span>
          <span class="tag ${diffClass}">${q.difficulty}</span>
          <span class="tag">${q.timer}s</span>
          <span class="tag">${q.choices.length} choices</span>
        </div>
      `;
      card.querySelector('[data-act=edit]').addEventListener('click', () => this.editQuestion(q.id));
      card.querySelector('[data-act=dup]').addEventListener('click', () => {
        this.bank.duplicate(q.id);
        this.renderQuestionList();
        this.refreshStartButton();
        this.toast('Question duplicated');
      });
      card.querySelector('[data-act=del]').addEventListener('click', () => {
        if (confirm('Delete this question permanently?')){
          this.bank.delete(q.id);
          this.renderQuestionList();
          this.renderFilters();
          this.refreshStartButton();
          this.toast('Question deleted');
        }
      });
      frag.appendChild(card);
    });
    list.appendChild(frag);
  }

  editQuestion(id){
    const q = this.bank.getById(id);
    if (!q) return;
    this.$('questionId').value = q.id;
    this.$('qText').value = q.text;
    this.$('qCategory').value = q.category || '';
    this.$('qDifficulty').value = q.difficulty || 'Medium';
    this.$('qTimer').value = q.timer || 30;
    this.$('qImage').value = q.image || '';
    this.$('qExplanation').value = q.explanation || '';
    this.editingChoices = q.choices.map(c => ({ ...c }));
    this.renderChoiceRows();
    this.$('formTitle').textContent = 'Edit Question';
    this.$('saveQuestionBtn').textContent = 'Save Changes';
    this.$('cancelEditBtn').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  exportQuestions(){
    const blob = new Blob([this.bank.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'examinar-questions.json';
    a.click();
    URL.revokeObjectURL(url);
    this.toast('Questions exported');
  }

  importQuestions(e){
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const n = this.bank.importJSON(reader.result);
        this.renderQuestionList();
        this.renderFilters();
        this.refreshStartButton();
        this.toast(`Imported ${n} question(s)`);
      }catch(err){
        this.toast('Import failed: invalid JSON file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  resetAllData(){
    if (!confirm('This clears all questions and statistics stored on this device. Continue?')) return;
    Storage.remove(STORAGE_KEYS.QUESTIONS);
    Storage.remove(STORAGE_KEYS.STATS);
    Storage.remove(STORAGE_KEYS.HISTORY);
    this.bank = new QuestionBank();
    this.stats = new StatsStore();
    this.renderQuestionList();
    this.renderFilters();
    this.renderStats();
    this.refreshStartButton();
    this.toast('All data reset to defaults');
  }

  refreshStartButton(){
    const has = this.bank.count() > 0;
    this.$('startExamBtn').disabled = !has;
    this.$('startHint').hidden = has;
  }

  /* ======================================================================
     EXAM LAUNCH + LIVE EXAM VIEW
     ====================================================================== */
  bindExamEvents(){
    this.$('pauseBtn').addEventListener('click', () => this.togglePause());
    this.$('resumeBtn').addEventListener('click', () => this.togglePause());
    this.$('fullscreenBtn').addEventListener('click', () => this.toggleFullscreen());
    this.$('flagBtn').addEventListener('click', () => this.toggleFlagCurrent());
    this.$('quitBtn').addEventListener('click', () => this.quitExam());
    this.$('dismissWarningBtn').addEventListener('click', () => { this.$('focusWarning').hidden = true; });
    this.$('reenterFsBtn').addEventListener('click', () => { this.toggleFullscreen(); this.$('fsWarning').hidden = true; });
    this.$('ignoreFsBtn').addEventListener('click', () => { this.$('fsWarning').hidden = true; });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.session && this.isExamActive()) this.flagFocusLoss();
    });
    window.addEventListener('blur', () => {
      if (this.session && this.isExamActive()) this.flagFocusLoss();
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && this.session && this.isExamActive() && this._wantedFullscreen){
        this.$('fsWarning').hidden = false;
      }
    });

    document.addEventListener('keydown', (e) => {
      if (!this.isExamActive()) return;
      if (this.$('pauseOverlay').hidden === false && e.key !== 'Escape') return;
      if (['1', '2', '3', '4'].includes(e.key)){
        const btn = this.$('choicesArea').querySelectorAll('.choice-btn')[parseInt(e.key, 10) - 1];
        if (btn && !btn.disabled) btn.click();
      } else if (e.key === 'Escape'){
        this.togglePause();
      }
    });
  }

  isExamActive(){ return this.$('view-exam').classList.contains('is-active'); }

  launchExam(){
    const count = Utils.clamp(parseInt(this.$('examCount').value, 10) || 10, 1, this.bank.count());
    const category = this.$('examCategory').value;
    const mode = this.$('examMode').value;
    const soundEnabled = this.$('soundToggle').checked;

    let pool = category ? this.bank.all().filter(q => q.category === category) : this.bank.all().slice();
    if (pool.length === 0) pool = this.bank.all().slice();
    const chosen = Utils.shuffle(pool).slice(0, Math.min(count, pool.length));

    this.session = new ExamSession(chosen, { mode, soundEnabled });
    this.session.onTick = (left, total) => this.renderTimer(left, total);
    this.session.onAdvance = (status, chosen) => this.handleAdvance(status, chosen);
    this.session.onFinish = (results) => this.finishExam(results);

    this._wantedFullscreen = false;
    this.showView('exam');
    this.renderQuestion();
    this.session.startQuestionTimer();
    this.updateSidebar();
  }

  renderQuestion(){
    const q = this.session.currentQuestion();
    if (!q) return;
    this.$('qIndex').textContent = this.session.index + 1;
    this.$('qTotal').textContent = this.session.total();
    this.$('qMeta').textContent = `${q.category || 'General'} · ${q.difficulty}`;
    this.$('qText').textContent = q.text;

    const img = this.$('qImage');
    if (q.image){ img.src = q.image; img.hidden = false; } else { img.hidden = true; }

    const area = this.$('choicesArea');
    area.innerHTML = '';
    q.choices.forEach((choice, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice-btn';
      btn.setAttribute('role', 'listitem');
      btn.innerHTML = `<span class="choice-btn__key">${i + 1}</span><span>${Utils.escapeHtml(choice.text)}</span>`;
      btn.addEventListener('click', () => this.selectAnswer(choice.id));
      area.appendChild(btn);
    });

    this.$('progressFill').style.width = `${(this.session.index / this.session.total()) * 100}%`;
    this.updateFlagButton();
    this._answeredThisQuestion = false; // guards against double submission (click + timeout race)
  }

  selectAnswer(choiceId){
    if (this._answeredThisQuestion) return; // already locked in (e.g. timer just expired)
    this._answeredThisQuestion = true;
    this.session.submitAnswer(choiceId);
  }

  /**
   * Fires for every question, whether it was answered by a click or timed out.
   * Always locks the choices and reveals the correct one so the exam never
   * appears to "freeze" when time runs out with nothing selected.
   */
  handleAdvance(status, chosenId){
    this._answeredThisQuestion = true;
    const q = this.session.currentQuestion();
    const buttons = [...this.$('choicesArea').querySelectorAll('.choice-btn')];
    buttons.forEach(b => b.disabled = true);
    q.choices.forEach((choice, i) => {
      const btn = buttons[i];
      if (!btn) return;
      if (choice.correct) btn.classList.add('is-correct');
      if (chosenId && choice.id === chosenId){
        btn.classList.add('is-selected');
        if (!choice.correct) btn.classList.add('is-wrong');
      }
    });

    this.playSound(status === 'correct' ? 'sndCorrect' : status === 'wrong' ? 'sndWrong' : null);
    this.updateSidebar();
    setTimeout(() => {
      const hasNext = this.session.goNext();
      if (hasNext) this.renderQuestion();
    }, 1000);
  }

  renderTimer(left, total){
    const clock = this.$('timerClock');
    this.$('timerValue').textContent = Math.max(0, left);
    const circumference = 276.5;
    const ratio = Utils.clamp(left / total, 0, 1);
    this.$('timerArc').style.strokeDashoffset = String(circumference * (1 - ratio));
    clock.classList.toggle('is-low', left <= 5);
    this.$('statTime').textContent = Utils.formatTime(this.session.elapsedSeconds());
  }

  updateSidebar(){
    this.$('statAnswered').textContent = this.session.answeredCount();
    this.$('statRemaining').textContent = this.session.remainingCount();
    this.$('statScore').textContent = this.session.correctCount();
    this.$('statPercent').textContent = `${this.session.percentage()}%`;
    this.$('statWarnings').textContent = this.session.warningCount;
  }

  updateFlagButton(){
    const flagged = this.session.flags.has(this.session.currentQuestion().id);
    this.$('flagBtn').style.color = flagged ? 'var(--accent)' : '';
  }

  toggleFlagCurrent(){
    const flagged = this.session.toggleFlag();
    this.updateFlagButton();
    this.toast(flagged ? 'Flagged for review' : 'Flag removed');
  }

  togglePause(){
    if (!this.session) return;
    if (this.session.paused){
      this.session.resume();
      this.$('pauseOverlay').hidden = true;
    } else {
      this.session.pause();
      this.$('pauseOverlay').hidden = false;
    }
  }

  toggleFullscreen(){
    if (!document.fullscreenElement){
      document.documentElement.requestFullscreen().catch(() => {});
      this._wantedFullscreen = true;
    } else {
      document.exitFullscreen().catch(() => {});
      this._wantedFullscreen = false;
    }
  }

  flagFocusLoss(){
    if (this.session.paused || this._suppressFocusWarning) return;
    this.session.registerWarning();
    this.updateSidebar();
    this.$('focusWarning').hidden = false;
  }

  quitExam(){
    this._suppressFocusWarning = true; // the native confirm() dialog itself blurs the window
    const confirmed = confirm('Quit this exam? Your progress will be lost.');
    this._suppressFocusWarning = false;
    if (!confirmed) return;
    this.session.stopTimer();
    this.session = null;
    this.showView('admin');
  }

  playSound(kind){
    if (!kind || !this.session.soundEnabled) return;
    try{
      const ctx = this._audioCtx || (this._audioCtx = new (window.AudioContext || window.webkitAudioContext)());
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = kind === 'sndCorrect' ? 880 : kind === 'sndWrong' ? 220 : 660;
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(); osc.stop(ctx.currentTime + 0.3);
    }catch(e){ /* audio not available — fail silently */ }
  }

  /* ======================================================================
     RESULTS VIEW
     ====================================================================== */
  bindResultsEvents(){
    this.$('reviewBtn').addEventListener('click', () => { this.renderReview(); this.showView('review'); });
    this.$('restartBtn').addEventListener('click', () => this.restartExam());
    this.$('printBtn').addEventListener('click', () => window.print());
    this.$('backToBankBtn').addEventListener('click', () => this.showView('admin'));
  }

  finishExam(results){
    this.playSound('sndDone');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.stats.recordAttempt(results);
    this.lastResults = results;

    this.$('rTotal').textContent = results.total;
    this.$('rCorrect').textContent = results.correct;
    this.$('rWrong').textContent = results.wrong;
    this.$('rUnanswered').textContent = results.unanswered;
    this.$('rTime').textContent = Utils.formatTime(results.totalTimeSeconds);
    this.$('rAvg').textContent = `${results.avgTime}s`;
    this.$('scorePercent').textContent = `${results.percentage}%`;

    const stamp = this.$('gradeStamp');
    stamp.textContent = results.grade;
    stamp.className = 'grade-stamp' + (results.grade === 'Fail' ? ' grade--fail' : (results.grade === 'Excellent' || results.grade === 'Very Good') ? ' grade--pass' : '');

    const circumference = 326.7;
    const arc = this.$('scoreArc');
    arc.style.strokeDashoffset = String(circumference);
    requestAnimationFrame(() => { arc.style.strokeDashoffset = String(circumference * (1 - results.percentage / 100)); });

    this.showView('results');
    if (results.grade === 'Excellent') this.launchConfetti();
  }

  launchConfetti(){
    const colors = ['#e8b04b', '#4caf7d', '#e2555c', '#8ab4f8'];
    for (let i = 0; i < 60; i++){
      const el = document.createElement('div');
      el.className = 'confetti';
      el.style.left = `${Math.random() * 100}vw`;
      el.style.background = colors[i % colors.length];
      el.style.animationDuration = `${2 + Math.random() * 1.5}s`;
      el.style.opacity = String(0.7 + Math.random() * 0.3);
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 4000);
    }
  }

  restartExam(){
    const questions = this.session.queue.map(q => this.bank.getById(q.id)).filter(Boolean);
    const mode = this.session.mode;
    const soundEnabled = this.session.soundEnabled;
    this.session = new ExamSession(questions.length ? questions : this.bank.all(), { mode, soundEnabled });
    this.session.onTick = (left, total) => this.renderTimer(left, total);
    this.session.onAdvance = (status, chosen) => this.handleAdvance(status, chosen);
    this.session.onFinish = (results) => this.finishExam(results);
    this.showView('exam');
    this.renderQuestion();
    this.session.startQuestionTimer();
    this.updateSidebar();
  }

  /* ======================================================================
     REVIEW VIEW
     ====================================================================== */
  bindReviewEvents(){
    this.$('backToResultsBtn').addEventListener('click', () => this.showView('results'));
    this.$('reviewIncorrectOnlyBtn').addEventListener('click', (e) => {
      this.reviewIncorrectOnly = !this.reviewIncorrectOnly;
      e.target.textContent = this.reviewIncorrectOnly ? 'Show all questions' : 'Show incorrect only';
      this.renderReview();
    });
  }

  renderReview(){
    const trail = this.session.buildReview();
    const list = this.$('reviewList');
    list.innerHTML = '';
    const items = this.reviewIncorrectOnly ? trail.filter(t => t.status !== 'correct') : trail;

    if (items.length === 0){
      list.innerHTML = '<div class="empty-state">Nothing to show here.</div>';
      return;
    }

    items.forEach((item, i) => {
      const { question: q, chosenId, status, timeUsed, flagged } = item;
      const card = document.createElement('div');
      card.className = `review-item status--${status}`;
      const choicesHtml = q.choices.map(c => {
        let cls = '';
        if (c.correct) cls = 'correct';
        else if (c.id === chosenId) cls = 'wrong';
        const mark = c.correct ? '✓' : (c.id === chosenId ? '✕' : '');
        return `<div class="review-choice ${cls}"><span>${Utils.escapeHtml(c.text)}</span><span>${mark}</span></div>`;
      }).join('');

      card.innerHTML = `
        <div class="review-item__top">
          <strong>Question ${trail.indexOf(item) + 1}</strong>
          <span class="review-item__status">${status}${flagged ? ' · flagged' : ''}</span>
        </div>
        <div class="review-item__q">${Utils.escapeHtml(q.text)}</div>
        ${q.image ? `<img src="${q.image}" class="question-image" style="max-height:160px;margin-bottom:10px;">` : ''}
        <div class="review-item__choices">${choicesHtml}</div>
        ${q.explanation ? `<div class="review-item__explain">${Utils.escapeHtml(q.explanation)}</div>` : ''}
        <div class="review-item__meta">${q.category || 'General'} · ${q.difficulty} · ${timeUsed}s used of ${q.timer}s</div>
      `;
      list.appendChild(card);
    });
  }

  /* ======================================================================
     STATS VIEW
     ====================================================================== */
  renderStats(){
    const s = this.stats.stats;
    this.$('sHighest').textContent = s.highestScore;
    this.$('sLast').textContent = s.lastScore;
    this.$('sAverage').textContent = s.averageScore;
    this.$('sAttempts').textContent = s.totalAttempts;
    this.$('sBestPct').textContent = s.totalAttempts ? `${s.bestPercentage}%` : '—';
    this.$('sBestTime').textContent = s.bestTime !== null ? Utils.formatTime(s.bestTime) : '—';
    this.$('sLastDate').textContent = s.lastAttemptDate ? new Date(s.lastAttemptDate).toLocaleString() : '—';

    const list = this.$('historyList');
    list.innerHTML = '';
    if (this.stats.history.length === 0){
      list.innerHTML = '<div class="empty-state">No attempts yet — take an exam to build your history.</div>';
      return;
    }
    this.stats.history.forEach(h => {
      const row = document.createElement('div');
      row.className = 'history-row';
      row.innerHTML = `
        <span>${new Date(h.date).toLocaleString()}</span>
        <span>${h.correct}/${h.total} correct</span>
        <span class="history-row__pct">${h.percentage}%</span>
        <span>${Utils.formatTime(h.totalTimeSeconds)}</span>
      `;
      list.appendChild(row);
    });
  }
}

/* ==========================================================================
   BOOTSTRAP
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  window.examinarApp = new App();
});
