const { app, BrowserWindow, ipcMain, dialog, Tray, Menu } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const { initNotifications } = require('./notifications');

let mainWindow;
let db;
let noteWindows = new Map(); // To track always-on-top notes
let tray = null;
let forceQuit = false;

// Set app name for notifications
app.setName('NoteWhirl');

// For Windows, ensure notifications show the app name properly
if (process.platform === 'win32') {
  app.setAppUserModelId('com.notewhirl.app');
}

// Add a function to complete reminders from timeout
function completeReminderFromTimeout(reminderId) {
  // This function will be called by notifications.js
  if (db) {
    try {
      db.prepare(`
        UPDATE reminders SET is_completed = 1
        WHERE id = ?
      `).run(reminderId);
      console.log(`Reminder ${reminderId} marked as completed`);
    } catch (error) {
      console.error('Error completing reminder from timeout:', error);
    }
  }
}

// Handle notification action when app is closed
// This API is only available on macOS
if (process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets/icon-3.png')
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
  
  // Handle close event
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      mainWindow.hide();
      
      // Show notification only the first time
      if (tray && !tray.isBalloonShownPreviously) {
        tray.displayBalloon({
          title: 'NoteWhirl is still running',
          content: 'The app will continue to run in the background. Click the tray icon to restore or exit.',
          icon: path.join(__dirname, 'assets/icon-3.png')
        });
        tray.isBalloonShownPreviously = true;
        
        // Also show help window to explain how to find the tray icon
        showTrayHelp();
      }
      return false;
    }
  });
}

// Create system tray icon
function createTray() {
  // Use a smaller icon file which works better in the system tray
  const iconPath = path.join(__dirname, 'assets/icon-3.png');
  
  // If tray already exists, destroy it first to prevent duplicates
  if (tray !== null) {
    tray.destroy();
  }
  
  // Create new tray icon
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: 'Open NoteWhirl', 
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    { 
      label: 'Show Help', 
      click: () => {
        showTrayHelp();
      }
    },
    { type: 'separator' },
    { 
      label: 'Exit', 
      click: () => {
        forceQuit = true;
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('NoteWhirl - Click to restore');
  tray.setContextMenu(contextMenu);
  
  // Double click and single click on tray icon to restore the window
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
  
  // Add single click handler - this is essential for Windows
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
  
  console.log('System tray icon created successfully');
}

function initializeDatabase() {
  db = new Database('notes.db');
  
  // Create notes table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      text TEXT,
      formatted_text TEXT,
      color TEXT DEFAULT '#ffff99',
      font_size TEXT DEFAULT 'medium',
      x INTEGER,
      y INTEGER,
      width INTEGER DEFAULT 200,
      height INTEGER DEFAULT 200,
      always_on_top INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      font_family TEXT DEFAULT 'default',
      has_checklist INTEGER DEFAULT 0,
      has_images INTEGER DEFAULT 0
    )
  `);
  
  // Create images table for note attachments
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      image_data TEXT NOT NULL,
      file_name TEXT,
      created_at INTEGER DEFAULT 0,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    )
  `);
  
  // Create reminders table
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      reminder_time INTEGER NOT NULL,
      title TEXT,
      message TEXT,
      is_completed INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      play_sound INTEGER DEFAULT 1,
      urgent_style INTEGER DEFAULT 0,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    )
  `);
  
  // Create settings table for app preferences
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  
  // Check if columns exist, if not, add them
  const tableInfo = db.prepare("PRAGMA table_info(notes)").all();
  
  // Check if title column exists, if not, add it
  const titleColumnExists = tableInfo.some(column => column.name === 'title');
  if (!titleColumnExists) {
    console.log('Adding title column to notes table');
    db.exec('ALTER TABLE notes ADD COLUMN title TEXT');
  }
  
  // Check if created_at column exists, if not, add it
  const createdAtExists = tableInfo.some(column => column.name === 'created_at');
  if (!createdAtExists) {
    console.log('Adding created_at column to notes table');
    db.exec('ALTER TABLE notes ADD COLUMN created_at INTEGER DEFAULT 0');
  }
  
  // Check if font_family column exists, if not, add it
  const fontFamilyExists = tableInfo.some(column => column.name === 'font_family');
  if (!fontFamilyExists) {
    console.log('Adding font_family column to notes table');
    db.exec('ALTER TABLE notes ADD COLUMN font_family TEXT DEFAULT "default"');
  }
  
  // Check for formatting columns
  const formattedTextExists = tableInfo.some(column => column.name === 'formatted_text');
  if (!formattedTextExists) {
    console.log('Adding formatted_text column to notes table');
    db.exec('ALTER TABLE notes ADD COLUMN formatted_text TEXT');
  }
  
  const hasChecklistExists = tableInfo.some(column => column.name === 'has_checklist');
  if (!hasChecklistExists) {
    console.log('Adding has_checklist column to notes table');
    db.exec('ALTER TABLE notes ADD COLUMN has_checklist INTEGER DEFAULT 0');
  }
  
  const hasImagesExists = tableInfo.some(column => column.name === 'has_images');
  if (!hasImagesExists) {
    console.log('Adding has_images column to notes table');
    db.exec('ALTER TABLE notes ADD COLUMN has_images INTEGER DEFAULT 0');
  }
  
  // Check if reminder columns exist, if not, add them
  const reminderInfo = db.prepare("PRAGMA table_info(reminders)").all();
  const playSoundExists = reminderInfo.some(column => column.name === 'play_sound');
  if (!playSoundExists) {
    console.log('Adding play_sound column to reminders table');
    db.exec('ALTER TABLE reminders ADD COLUMN play_sound INTEGER DEFAULT 1');
  }
  
  const urgentStyleExists = reminderInfo.some(column => column.name === 'urgent_style');
  if (!urgentStyleExists) {
    console.log('Adding urgent_style column to reminders table');
    db.exec('ALTER TABLE reminders ADD COLUMN urgent_style INTEGER DEFAULT 0');
  }
  
  // Initialize default settings if they don't exist
  const initDefaultSettings = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES 
    ('theme', 'light'),
    ('default_color', '#ffff99'),
    ('default_font_size', 'medium'),
    ('default_font_family', 'default'),
    ('enable_formatting', 'true'),
    ('enable_images', 'true'),
    ('enable_reminders', 'true'),
    ('enable_checklists', 'true')
  `);
  initDefaultSettings.run();
  
  // Enable foreign keys support
  db.exec('PRAGMA foreign_keys = ON');
}

app.whenReady().then(() => {
  // Only allow a single instance of the app
  const gotTheLock = app.requestSingleInstanceLock();
  
  if (!gotTheLock) {
    app.quit();
    return;
  }
  
  initializeDatabase();
  createWindow();
  createTray();
  
  // Check if notifications are supported and request permission if needed
  if (process.platform === 'win32') {
    console.log('Checking notification permission on Windows');
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      console.log('Notifications are supported');
    } else {
      console.log('Notifications are not supported on this platform');
    }
  }
  
  // Initialize notifications after window is created
  initNotifications(db, mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Prevent the app from fully closing on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep app running for notifications on Windows but hide the window
    if (process.platform === 'win32') {
      console.log('All windows closed, but keeping app running for notifications');
    } else {
      app.quit();
    }
  }
});

// Before app quits completely
app.on('before-quit', () => {
  forceQuit = true;
  
  // Clean up database connection
  if (db) {
    try {
      db.close();
    } catch (err) {
      console.error('Error closing database:', err);
    }
  }
});

// Set up a reopening mechanism if app is launched while already running
app.on('second-instance', (event, commandLine, workingDirectory) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

// Handle always-on-top setting for notes
ipcMain.on('set-note-always-on-top', (event, data) => {
  const { id, alwaysOnTop } = data;
  
  // Set the z-index in the renderer process
  // This is a visual indication that's handled in the renderer
  
  // For future enhancement: create separate windows for always-on-top notes
  // that stay on top of other applications
  console.log(`Note ${id} always on top: ${alwaysOnTop}`);
});

// IPC handlers
ipcMain.on('save-notes', (event, notes) => {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO notes (
      id, title, text, formatted_text, color, font_size, x, y, width, height, 
      always_on_top, created_at, font_family, has_checklist, has_images
    )
    VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  db.transaction(() => {
    // Clear existing notes
    db.prepare('DELETE FROM notes').run();
    
    // Insert new notes
    notes.forEach(note => {
      stmt.run(
        note.id || null,
        note.title || '',
        note.text || '',
        note.formattedText || '',
        note.color || '#ffff99',
        note.fontSize || 'medium',
        parseInt(note.x),
        parseInt(note.y),
        note.width || 200,
        note.height || 200,
        note.alwaysOnTop ? 1 : 0,
        note.createdAt || Date.now(),
        note.fontFamily || 'default',
        note.hasChecklist ? 1 : 0,
        note.hasImages ? 1 : 0
      );
    });
  })();
});

ipcMain.handle('load-notes', () => {
  const notes = db.prepare('SELECT * FROM notes').all();
  return notes.map(note => ({
    ...note,
    alwaysOnTop: Boolean(note.always_on_top)
  }));
});

// New handler for exporting notes
ipcMain.handle('export-notes', async (event, notes) => {
  try {
    // Ask user for directory to save exported notes
    const { filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Folder to Export Notes'
    });
    
    if (!filePaths || filePaths.length === 0) {
      return { success: false, message: 'Export cancelled' };
    }
    
    const exportDir = filePaths[0];
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const exportFolderName = `notewhirl-export-${timestamp}`;
    const fullExportPath = path.join(exportDir, exportFolderName);
    
    // Create export directory
    if (!fs.existsSync(fullExportPath)) {
      fs.mkdirSync(fullExportPath);
    }
    
    // Export each note as a text file
    let successCount = 0;
    for (const note of notes) {
      const noteTitle = note.title && note.title.trim() !== '' 
        ? note.title.replace(/[^a-z0-9]/gi, '_').substring(0, 30) 
        : `note_${note.id}`;
      
      const fileName = `${noteTitle}_${note.id}.txt`;
      const filePath = path.join(fullExportPath, fileName);
      
      // Create note content
      const createdDate = new Date(parseInt(note.createdAt)).toLocaleString();
      let fileContent = '';
      
      if (note.title && note.title.trim() !== '') {
        fileContent += `TITLE: ${note.title}\n\n`;
      }
      
      fileContent += `${note.text}\n\n`;
      fileContent += `---------------------\n`;
      fileContent += `Created: ${createdDate}\n`;
      fileContent += `Color: ${note.color}\n`;
      fileContent += `Font Size: ${note.fontSize}\n`;
      
      // Write to file
      fs.writeFileSync(filePath, fileContent);
      successCount++;
    }
    
    return { 
      success: true, 
      message: `Successfully exported ${successCount} notes to ${fullExportPath}`,
      path: fullExportPath
    };
  } catch (error) {
    console.error('Export error:', error);
    return { 
      success: false, 
      message: `Error exporting notes: ${error.message}` 
    };
  }
});

// Add new handlers for settings
ipcMain.on('save-settings', (event, settings) => {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO settings (key, value)
    VALUES (?, ?)
  `);

  db.transaction(() => {
    for (const [key, value] of Object.entries(settings)) {
      stmt.run(key, value);
    }
  })();
});

ipcMain.handle('load-settings', () => {
  const settings = {};
  const rows = db.prepare('SELECT key, value FROM settings').all();
  
  rows.forEach(row => {
    settings[row.key] = row.value;
  });
  
  return settings;
});

// Add new handlers for images
ipcMain.on('save-image', (event, data) => {
  try {
    const { noteId, imageData, fileName } = data;
    
    const stmt = db.prepare(`
      INSERT INTO note_images (note_id, image_data, file_name, created_at)
      VALUES (?, ?, ?, ?)
    `);
    
    const now = Date.now();
    const info = stmt.run(
      noteId,
      imageData,
      fileName || 'image.png',
      now
    );
    
    // Update the note to indicate it has images
    db.prepare(`
      UPDATE notes SET has_images = 1 WHERE id = ?
    `).run(noteId);
    
    event.reply('save-image-reply', { 
      success: true, 
      id: info.lastInsertRowid,
      noteId,
      fileName 
    });
  } catch (error) {
    console.error('Error saving image:', error);
    event.reply('save-image-reply', { 
      success: false, 
      error: error.message 
    });
  }
});

ipcMain.handle('get-note-images', (event, noteId) => {
  try {
    const images = db.prepare(`
      SELECT id, file_name, created_at FROM note_images 
      WHERE note_id = ?
      ORDER BY created_at DESC
    `).all(noteId);
    
    return { success: true, images };
  } catch (error) {
    console.error('Error fetching images:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-image-data', (event, imageId) => {
  try {
    const image = db.prepare(`
      SELECT image_data FROM note_images WHERE id = ?
    `).get(imageId);
    
    if (!image) {
      return { success: false, error: 'Image not found' };
    }
    
    return { success: true, imageData: image.image_data };
  } catch (error) {
    console.error('Error fetching image data:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.on('delete-image', (event, imageId) => {
  try {
    // Get the note ID before deleting the image
    const image = db.prepare(`
      SELECT note_id FROM note_images WHERE id = ?
    `).get(imageId);
    
    if (!image) {
      event.reply('delete-image-reply', { 
        success: false, 
        error: 'Image not found' 
      });
      return;
    }
    
    // Delete the image
    db.prepare(`
      DELETE FROM note_images WHERE id = ?
    `).run(imageId);
    
    // Check if this note has any images left
    const remainingImages = db.prepare(`
      SELECT COUNT(*) as count FROM note_images WHERE note_id = ?
    `).get(image.note_id);
    
    // If no images remain, update the note
    if (remainingImages.count === 0) {
      db.prepare(`
        UPDATE notes SET has_images = 0 WHERE id = ?
      `).run(image.note_id);
    }
    
    event.reply('delete-image-reply', { success: true });
  } catch (error) {
    console.error('Error deleting image:', error);
    event.reply('delete-image-reply', { 
      success: false, 
      error: error.message 
    });
  }
});

// Function to show help message for finding the tray icon
function showTrayHelp() {
  const helpWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Create a simple HTML content to explain how to find the tray icon
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Finding NoteWhirl in System Tray</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          padding: 20px;
          line-height: 1.5;
        }
        h2 {
          color: #4a90e2;
        }
        .steps {
          margin-top: 15px;
        }
        .step {
          margin-bottom: 10px;
        }
        .buttons {
          margin-top: 20px;
          text-align: center;
        }
        button {
          padding: 8px 16px;
          background: #4a90e2;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <h2>Finding NoteWhirl in System Tray</h2>
      <div class="steps">
        <div class="step">1. Look at the bottom-right corner of your screen in the taskbar (notification area)</div>
        <div class="step">2. Click on the up-arrow icon (^) to show hidden icons</div>
        <div class="step">3. Look for the NoteWhirl icon</div>
        <div class="step">4. Click on the icon to restore the app</div>
        <div class="step">5. To make the icon always visible, drag it from the hidden icons area to your taskbar</div>
      </div>
      <div class="buttons">
        <button onclick="window.close()">OK, Got it!</button>
      </div>
      <script>
        // Close this window when clicking anywhere outside
        setTimeout(() => {
          document.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON') {
              window.close();
            }
          });
        }, 1000);
      </script>
    </body>
    </html>
  `;

  // Write the HTML to a temporary file
  const tempPath = path.join(app.getPath('temp'), 'notewhirl-tray-help.html');
  fs.writeFileSync(tempPath, htmlContent);

  // Load the temp HTML file
  helpWindow.loadFile(tempPath);
  
  // Remove the menu
  helpWindow.setMenuBarVisibility(false);
  
  // Clean up when the window is closed
  helpWindow.on('closed', () => {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (error) {
      console.error('Failed to delete temporary help file:', error);
    }
  });
}

// Export the function for notifications.js to use
module.exports = {
  completeReminderFromTimeout
}; 