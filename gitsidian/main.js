const { Plugin, ItemView, Notice, Setting, TFile, setIcon, PluginSettingTab } = require('obsidian');

const VIEW_SOURCE = "gitsidian-source";
const VIEW_HISTORY = "gitsidian-history";
const VIEW_DETAILS = "gitsidian-details";
const VIEW_ACTIVITY = "gitsidian-activity";

const Icons = {
    GitBranch: "git-branch",
    RefreshCw: "refresh-cw",
    Check: "check",
    History: "history",
    FileText: "file-text",
    Folder: "folder",
    Calendar: "calendar",
};

const DEFAULT_SETTINGS = {
    dataFilePath: "git-data.json",
    autoScanIntervalMinutes: 5,
    graphView: "year",
    color1: "#00ff88",
    color2: "#00e676",
    color3: "#00c853",
    color4: "#00b248",
    currentWeekColor: "#ff6b6b",
};

function basename(filePath) {
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
}

function formatDate(ts) {
    return new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function formatDateShort(ts) {
    return new Date(ts).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric"
    });
}

function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function toISODate(ts) {
    return new Date(ts).toISOString().slice(0, 10);
}

function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((((d - yearStart) / 86400000) + 1) / 7));
    return weekNo;
}

class DataManager {
    constructor(vault, dataFilePath) {
        this.vault = vault;
        this.dataFilePath = dataFilePath;
    }

    async scanVault() {
        const files = this.vault.getFiles();
        const data = {
            scannedAt: new Date().toISOString(),
            fileCount: files.length,
            files: {}
        };

        for (const file of files) {
            if (file.path === this.dataFilePath) continue;
            data.files[file.path] = {
                created: file.stat.ctime,
                modified: file.stat.mtime,
                size: file.stat.size
            };
        }

        await this.vault.adapter.write(this.dataFilePath, JSON.stringify(data, null, 2));
        return data;
    }

    async loadData() {
        try {
            const content = await this.vault.adapter.read(this.dataFilePath);
            return JSON.parse(content);
        } catch (e) {
            console.warn("[Gitsidian] Failed to load data file:", e);
            return null;
        }
    }

    async ensureData() {
        let data = await this.loadData();
        if (!data) {
            data = await this.scanVault();
            new Notice("Gitsidian: Created git-data.json");
        }
        return data;
    }
}

class ActivityView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.currentView = plugin.settings.graphView || "year";
    }

    getViewType() { return VIEW_ACTIVITY; }
    getDisplayText() { return "Activity Graph"; }
    getIcon() { return Icons.Calendar; }

    async onOpen() {
        this.containerEl.children[1].empty();
        this.contentEl = this.containerEl.children[1].createEl("div", {
            cls: "gitsidian-contribution-container gitsidian-resizable"
        });
        await this.render();
    }

    async render() {
        this.contentEl.empty();
        const data = await this.plugin.dataManager.ensureData();
        
        if (!data || !data.files) {
            this.contentEl.setText("No data found. Click refresh to scan vault.");
            return;
        }

        this.contentEl.style.setProperty('--gitsidian-color-1', this.plugin.settings.color1);
        this.contentEl.style.setProperty('--gitsidian-color-2', this.plugin.settings.color2);
        this.contentEl.style.setProperty('--gitsidian-color-3', this.plugin.settings.color3);
        this.contentEl.style.setProperty('--gitsidian-color-4', this.plugin.settings.color4);
        this.contentEl.style.setProperty('--gitsidian-current-week-color', this.plugin.settings.currentWeekColor);

        const header = this.contentEl.createEl("div", { cls: "gitsidian-view-header" });
        header.createEl("h4", { text: "Activity Graph" });

        const controls = header.createEl("div", { cls: "gitsidian-btn-group" });
        const viewToggle = controls.createEl("div", { cls: "gitsidian-view-toggle" });
        
        const monthBtn = viewToggle.createEl("button", { 
            cls: `gitsidian-view-toggle-btn ${this.currentView === 'month' ? 'active' : ''}`, 
            text: "Month" 
        });
        const yearBtn = viewToggle.createEl("button", { 
            cls: `gitsidian-view-toggle-btn ${this.currentView === 'year' ? 'active' : ''}`, 
            text: "Year" 
        });

        monthBtn.addEventListener("click", async () => {
            this.currentView = "month";
            this.plugin.settings.graphView = "month";
            await this.plugin.saveSettings();
            await this.render();
        });

        yearBtn.addEventListener("click", async () => {
            this.currentView = "year";
            this.plugin.settings.graphView = "year";
            await this.plugin.saveSettings();
            await this.render();
        });

        const refreshBtn = controls.createEl("span", { 
            cls: "gitsidian-header-btn", 
            attr: { "aria-label": "Refresh", role: "button", tabindex: "0" } 
        });
        setIcon(refreshBtn, Icons.RefreshCw);
        refreshBtn.addEventListener("click", async () => {
            await this.plugin.dataManager.scanVault();
            await this.render();
        });

        const counts = {};
        for (const [path, meta] of Object.entries(data.files)) {
            const created = toISODate(meta.created);
            const modified = toISODate(meta.modified);
            counts[created] = (counts[created] || 0) + 1;
            if (modified !== created) counts[modified] = (counts[modified] || 0) + 1;
        }

        const gridWrap = this.contentEl.createEl("div", { cls: "gitsidian-contribution-wrap" });
        
        const today = new Date();
        let start = new Date(today);
        if (this.currentView === "month") {
            start.setDate(today.getDate() - 30);
        } else {
            start.setDate(today.getDate() - 364);
        }

        const maxCount = Math.max(1, ...Object.values(counts));
        const currentWeekNum = getWeekNumber(today);
        const currentYear = today.getFullYear();

        const weeks = [];
        let currentDate = new Date(start);
        
        while (currentDate.getDay() !== 0) {
            currentDate.setDate(currentDate.getDate() - 1);
        }

        const endDate = new Date(today);
        endDate.setDate(endDate.getDate() + (6 - endDate.getDay()));

        while (currentDate <= endDate) {
            const weekDays = [];
            const weekStart = new Date(currentDate);
            
            for (let i = 0; i < 7; i++) {
                const dayDate = new Date(currentDate);
                const iso = toISODate(dayDate.getTime());
                const count = counts[iso] || 0;
                let level = 0;
                if (count > 0) level = Math.min(4, Math.ceil((count / maxCount) * 4));
                
                weekDays.push({
                    date: dayDate,
                    iso,
                    count,
                    level,
                    isCurrentWeek: getWeekNumber(dayDate) === currentWeekNum && dayDate.getFullYear() === currentYear
                });
                currentDate.setDate(currentDate.getDate() + 1);
            }
            
            weeks.push({
                startDate: weekStart,
                days: weekDays,
                weekNum: getWeekNumber(weekStart),
                month: weekStart.getMonth()
            });
        }

        const grid = gridWrap.createEl("div", { cls: "gitsidian-contribution-grid-vertical" });
        
        const dayLabelsRow = grid.createEl("div", { cls: "gitsidian-day-labels-row" });
        dayLabelsRow.createEl("div", { cls: "gitsidian-month-label-spacer" });
        
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        dayNames.forEach(day => {
            dayLabelsRow.createEl("div", { cls: "gitsidian-day-label", text: day });
        });

        let lastMonth = -1;
        weeks.forEach((week, idx) => {
            const row = grid.createEl("div", { cls: "gitsidian-week-row" });
            const monthLabel = row.createEl("div", { cls: "gitsidian-month-label" });
            
            if (week.month !== lastMonth) {
                const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                monthLabel.setText(months[week.month]);
                lastMonth = week.month;
                if (idx > 0) {
                    row.classList.add("gitsidian-month-separator");
                }
            }

            week.days.forEach(day => {
                const cell = row.createEl("div", {
                    cls: `gitsidian-contribution-cell level-${day.level}`,
                    attr: { 
                        "aria-label": `${day.iso}: ${day.count} change${day.count === 1 ? "" : "s"}`,
                        "data-date": day.iso
                    }
                });
                if (day.isCurrentWeek) {
                    cell.classList.add("gitsidian-current-week");
                }
            });
        });

        const legend = this.contentEl.createEl("div", { cls: "gitsidian-contribution-legend" });
        legend.createEl("span", { text: "Less", cls: "gitsidian-contribution-legend-text" });
        
        for (let i = 0; i <= 4; i++) {
            legend.createEl("div", { cls: `gitsidian-contribution-cell level-${i}` });
        }
        
        legend.createEl("span", { text: "More", cls: "gitsidian-contribution-legend-text" });

        const currentWeekIndicator = legend.createEl("div", { 
            cls: "gitsidian-contribution-cell gitsidian-current-week",
            attr: { "aria-label": "Current week" }
        });
        legend.createEl("span", { text: "Current Week", cls: "gitsidian-contribution-legend-text" });
    }
}

class FileExplorerView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return VIEW_SOURCE; }
    getDisplayText() { return "Vault Files"; }
    getIcon() { return Icons.GitBranch; }

    async onOpen() {
        const c = this.containerEl.children[1];
        c.empty();
        
        const header = c.createEl("div", { cls: "gitsidian-view-header" });
        header.createEl("h4", { text: "Vault Files" });
        
        const btns = header.createEl("div", { cls: "gitsidian-btn-group" });
        this.mkBtn(btns, Icons.RefreshCw, "Rescan vault", async () => {
            await this.plugin.dataManager.scanVault();
            await this.refresh();
        });

        this.listEl = c.createEl("div", { cls: "gitsidian-file-list" });
        this.interval = window.setInterval(() => this.refresh(), 5000);
        this.plugin.registerInterval(this.interval);
        
        await this.refresh();
    }

    onClose() {
        if (this.interval) {
            window.clearInterval(this.interval);
            this.interval = null;
        }
    }

    mkBtn(parent, icon, label, action) {
        const btn = parent.createEl("span", {
            cls: "gitsidian-header-btn",
            attr: { "aria-label": label, role: "button", tabindex: "0" }
        });
        setIcon(btn, icon);
        btn.addEventListener("click", action);
        return btn;
    }

    async refresh() {
        const data = await this.plugin.dataManager.ensureData();
        if (!data || !data.files) {
            this.listEl.setText("No data. Click refresh to scan.");
            return;
        }
        this.render(data.files);
    }

    render(files) {
        this.listEl.empty();
        const entries = Object.entries(files).sort((a, b) => b[1].modified - a[1].modified);
        
        if (!entries.length) {
            const empty = this.listEl.createEl("div", { cls: "gitsidian-empty-state" });
            setIcon(empty.createEl("div", { cls: "gitsidian-empty-icon" }), Icons.Check);
            empty.createEl("p", { text: "No files found." });
            return;
        }

        const groups = {};
        for (const [path, meta] of entries) {
            const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
            if (!groups[dir]) groups[dir] = [];
            groups[dir].push({ path, ...meta });
        }

        for (const [dir, items] of Object.entries(groups)) {
            const d = this.listEl.createEl("div", { cls: "gitsidian-dir-group" });
            const dh = d.createEl("div", { cls: "gitsidian-dir-header" });
            setIcon(dh.createEl("span", { cls: "gitsidian-dir-icon" }), Icons.Folder);
            dh.createEl("span", { text: dir || ".", cls: "gitsidian-dir-name" });
            
            const fl = d.createEl("div", { cls: "gitsidian-dir-files" });
            for (const f of items) this.renderFile(fl, f);
        }
    }

    renderFile(parent, entry) {
        const row = parent.createEl("div", { cls: "gitsidian-file-row" });
        
        const isNew = (Date.now() - entry.created) < 86400000;
        const badgeCode = isNew ? "A" : "M";
        
        row.createEl("span", { 
            cls: `gitsidian-status-badge gitsidian-status-${badgeCode}`, 
            text: badgeCode, 
            attr: { "aria-label": isNew ? "Created recently" : "Modified" } 
        });

        const name = row.createEl("span", { 
            cls: "gitsidian-file-name", 
            text: basename(entry.path), 
            attr: { role: "button", tabindex: "0" } 
        });
        name.addEventListener("click", () => this.openFile(entry.path));

        row.createEl("span", { cls: "gitsidian-file-meta", text: formatDateShort(entry.modified) });

        const diffBtn = row.createEl("span", { 
            cls: "gitsidian-file-action", 
            attr: { "aria-label": "View details", role: "button", tabindex: "0" } 
        });
        setIcon(diffBtn, Icons.FileText);
        diffBtn.addEventListener("click", () => this.plugin.openDetails(entry.path));
    }

    async openFile(p) {
        const f = this.plugin.app.vault.getAbstractFileByPath(p);
        if (f instanceof TFile) await this.plugin.app.workspace.openLinkText(f.path, "", false);
    }
}

class HistoryView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return VIEW_HISTORY; }
    getDisplayText() { return "History"; }
    getIcon() { return Icons.History; }

    async onOpen() {
        const c = this.containerEl.children[1];
        c.empty();
        
        const header = c.createEl("div", { cls: "gitsidian-view-header" });
        header.createEl("h4", { text: "File History" });
        
        const rb = header.createEl("span", { 
            cls: "gitsidian-header-btn", 
            attr: { role: "button", tabindex: "0" } 
        });
        setIcon(rb, Icons.RefreshCw);
        rb.addEventListener("click", () => this.refresh());

        this.commitsEl = c.createEl("div", { cls: "gitsidian-commits-list" });
        this.interval = window.setInterval(() => this.refresh(), 5000);
        this.plugin.registerInterval(this.interval);
        
        await this.refresh();
    }

    onClose() {
        if (this.interval) {
            window.clearInterval(this.interval);
            this.interval = null;
        }
    }

    async refresh() {
        const data = await this.plugin.dataManager.ensureData();
        if (!data || !data.files) {
            this.commitsEl.setText("No data found.");
            return;
        }
        this.render(data.files);
    }

    render(files) {
        this.commitsEl.empty();
        const events = [];
        
        for (const [path, meta] of Object.entries(files)) {
            events.push({ path, date: meta.created, type: "created", size: meta.size });
            if (meta.modified !== meta.created) {
                events.push({ path, date: meta.modified, type: "modified", size: meta.size });
            }
        }
        
        events.sort((a, b) => b.date - a.date);

        if (!events.length) {
            const empty = this.commitsEl.createEl("div", { cls: "gitsidian-empty-state" });
            setIcon(empty.createEl("div", { cls: "gitsidian-empty-icon" }), Icons.History);
            empty.createEl("p", { text: "No history yet." });
            return;
        }

        for (const ev of events) this.renderCard(ev);
    }

    renderCard(ev) {
        const card = this.commitsEl.createEl("div", { cls: "gitsidian-commit-card" });
        
        const top = card.createEl("div", { cls: "gitsidian-commit-top" });
        top.createEl("span", { 
            cls: `gitsidian-status-badge gitsidian-status-${ev.type === "created" ? "A" : "M"}`, 
            text: ev.type === "created" ? "Created" : "Modified" 
        });
        top.createEl("span", { cls: "gitsidian-commit-msg", text: basename(ev.path) });

        const meta = card.createEl("div", { cls: "gitsidian-commit-meta" });
        meta.createEl("span", { text: formatDate(ev.date), cls: "gitsidian-commit-date" });
        meta.createEl("span", { text: "•", cls: "gitsidian-commit-sep" });
        meta.createEl("span", { text: formatBytes(ev.size), cls: "gitsidian-commit-refs" });

        const p = card.createEl("div", { 
            cls: "gitsidian-commit-file-path", 
            text: ev.path, 
            attr: { role: "button", tabindex: "0" } 
        });
        p.addEventListener("click", () => this.plugin.openDetails(ev.path));
    }
}

class DetailsView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.currentPath = null;
    }

    getViewType() { return VIEW_DETAILS; }
    getDisplayText() {
        return this.currentPath ? `Details: ${basename(this.currentPath)}` : "File Details";
    }
    getIcon() { return Icons.FileText; }

    async onOpen() {
        this.containerEl.children[1].empty();
        this.contentEl = this.containerEl.children[1].createEl("div", { cls: "gitsidian-diff-content" });
        this.showPlaceholder();
    }

    showPlaceholder() {
        this.contentEl.empty();
        const empty = this.contentEl.createEl("div", { cls: "gitsidian-empty-state" });
        setIcon(empty.createEl("div", { cls: "gitsidian-empty-icon" }), Icons.FileText);
        empty.createEl("p", { text: "Select a file to view its details." });
    }

    async loadDetails(filePath) {
        this.currentPath = filePath;
        this.contentEl.empty();
        
        const data = await this.plugin.dataManager.ensureData();
        const meta = data?.files?.[filePath];
        
        if (!meta) {
            this.contentEl.setText("File not found in data.");
            return;
        }

        const header = this.contentEl.createEl("div", { cls: "gitsidian-diff-header" });
        header.createEl("h4", { text: basename(filePath), cls: "gitsidian-diff-path" });

        const details = this.contentEl.createEl("div", { cls: "gitsidian-file-details" });
        
        const r1 = details.createEl("div", { cls: "gitsidian-detail-row" });
        r1.createEl("span", { cls: "gitsidian-detail-label", text: "Created:" });
        r1.createEl("span", { cls: "gitsidian-detail-value", text: formatDate(meta.created) });

        const r2 = details.createEl("div", { cls: "gitsidian-detail-row" });
        r2.createEl("span", { cls: "gitsidian-detail-label", text: "Modified:" });
        r2.createEl("span", { cls: "gitsidian-detail-value", text: formatDate(meta.modified) });

        const r3 = details.createEl("div", { cls: "gitsidian-detail-row" });
        r3.createEl("span", { cls: "gitsidian-detail-label", text: "Size:" });
        r3.createEl("span", { cls: "gitsidian-detail-value", text: formatBytes(meta.size) });

        const r4 = details.createEl("div", { cls: "gitsidian-detail-row" });
        r4.createEl("span", { cls: "gitsidian-detail-label", text: "Path:" });
        r4.createEl("span", { cls: "gitsidian-detail-value", text: filePath });

        if (filePath.endsWith(".md")) {
            try {
                const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    const content = await this.plugin.app.vault.read(file);
                    const preview = this.contentEl.createEl("div", { cls: "gitsidian-file-preview" });
                    preview.createEl("h5", { text: "Preview" });
                    
                    const pre = preview.createEl("pre", { cls: "gitsidian-diff-pre" });
                    const lines = content.split("\n").slice(0, 30).join("\n");
                    pre.setText(lines + (content.split("\n").length > 30 ? "\n..." : ""));
                }
            } catch (e) { 
                console.warn("[Gitsidian] Failed to read file preview:", e); 
            }
        }
    }
}

class GitsidianSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "Gitsidian Settings" });

        new Setting(containerEl)
            .setName("Data file path")
            .setDesc("Where to store the scanned vault metadata.")
            .addText((t) => t.setValue(this.plugin.settings.dataFilePath).onChange(async (v) => {
                this.plugin.settings.dataFilePath = v || "git-data.json";
                await this.plugin.saveSettings();
                this.plugin.dataManager.dataFilePath = this.plugin.settings.dataFilePath;
            }));

        new Setting(containerEl)
            .setName("Auto-scan interval")
            .setDesc("Minutes between automatic rescans. 0 to disable.")
            .addSlider((s) => s.setLimits(0, 60, 1)
                .setValue(this.plugin.settings.autoScanIntervalMinutes)
                .setDynamicTooltip()
                .onChange(async (v) => {
                    this.plugin.settings.autoScanIntervalMinutes = v;
                    await this.plugin.saveSettings();
                    this.plugin.restartAutoScan();
                }));

        new Setting(containerEl)
            .setName("Default graph view")
            .setDesc("Choose between month or year view.")
            .addDropdown((d) => d
                .addOption("month", "Month")
                .addOption("year", "Year")
                .setValue(this.plugin.settings.graphView)
                .onChange(async (v) => {
                    this.plugin.settings.graphView = v;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl("h3", { text: "Graph Colors" });
        const colorContainer = containerEl.createEl("div", { cls: "gitsidian-color-picker" });
        
        const colors = [
            { key: "color1", label: "Level 1" },
            { key: "color2", label: "Level 2" },
            { key: "color3", label: "Level 3" },
            { key: "color4", label: "Level 4" },
            { key: "currentWeekColor", label: "Current Week" },
        ];

        for (const color of colors) {
            const colorGroup = colorContainer.createEl("div");
            colorGroup.createEl("label", { text: color.label });
            
            const input = colorGroup.createEl("input", { 
                type: "color", 
                cls: "gitsidian-color-input",
                attr: { value: this.plugin.settings[color.key] }
            });
            
            input.addEventListener("input", async (e) => {
                this.plugin.settings[color.key] = e.target.value;
                await this.plugin.saveSettings();
            });
        }

        const btnRow = containerEl.createEl("div", { cls: "setting-item" });
        const btn = btnRow.createEl("button", { text: "Rescan vault now", cls: "mod-cta" });
        btn.addEventListener("click", async () => {
            await this.plugin.dataManager.scanVault();
            new Notice("Vault rescanned.");
        });
    }
}

class GitsidianPlugin extends Plugin {
    async onload() {
        try {
            await this.loadSettings();
            this.dataManager = new DataManager(this.app.vault, this.settings.dataFilePath);

            this.registerView(VIEW_SOURCE, (leaf) => new FileExplorerView(leaf, this));
            this.registerView(VIEW_HISTORY, (leaf) => new HistoryView(leaf, this));
            this.registerView(VIEW_DETAILS, (leaf) => new DetailsView(leaf, this));
            this.registerView(VIEW_ACTIVITY, (leaf) => new ActivityView(leaf, this));

            this.addRibbonIcon(Icons.GitBranch, "Vault Files", () => this.activateView(VIEW_SOURCE));
            this.addRibbonIcon(Icons.History, "History", () => this.activateView(VIEW_HISTORY));
            this.addRibbonIcon(Icons.Calendar, "Activity Graph", () => this.activateView(VIEW_ACTIVITY));

            this.addCommand({ id: "open-source", name: "Open Vault Files", callback: () => this.activateView(VIEW_SOURCE) });
            this.addCommand({ id: "open-history", name: "Open History", callback: () => this.activateView(VIEW_HISTORY) });
            this.addCommand({ id: "open-activity", name: "Open Activity Graph", callback: () => this.activateView(VIEW_ACTIVITY) });
            
            this.addCommand({ 
                id: "rescan-vault", 
                name: "Rescan vault data", 
                callback: async () => {
                    await this.dataManager.scanVault();
                    new Notice("Vault rescanned.");
                }
            });

            this.addSettingTab(new GitsidianSettingTab(this.app, this));
            
            this.startAutoScan();
            await this.dataManager.ensureData();
            
        } catch (err) {
            console.error("[Gitsidian] onload error:", err);
            new Notice("Gitsidian failed to load: " + err.message, 0);
        }
    }

    onunload() {
        this.stopAutoScan();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    startAutoScan() {
        this.stopAutoScan();
        if (this.settings.autoScanIntervalMinutes > 0) {
            this.autoInterval = window.setInterval(() =>
                this.dataManager.scanVault(),
                this.settings.autoScanIntervalMinutes * 60000
            );
            this.registerInterval(this.autoInterval);
        }
    }

    stopAutoScan() {
        if (this.autoInterval) {
            window.clearInterval(this.autoInterval);
            this.autoInterval = null;
        }
    }

    restartAutoScan() {
        this.stopAutoScan();
        this.startAutoScan();
    }

    async activateView(type) {
        const ws = this.app.workspace;
        const leaves = ws.getLeavesOfType(type);
        let leaf = leaves[0] || ws.getRightLeaf(false);
        
        if (!leaves.length) await leaf.setViewState({ type, active: true });
        ws.revealLeaf(leaf);
    }

    async openDetails(filePath) {
        await this.activateView(VIEW_DETAILS);
        const leaves = this.app.workspace.getLeavesOfType(VIEW_DETAILS);
        if (leaves.length) await leaves[0].view.loadDetails(filePath);
    }
}

module.exports = GitsidianPlugin;