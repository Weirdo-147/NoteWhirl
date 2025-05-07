const { ipcMain, Notification } = require('electron');
const path = require('path');
const { exec } = require('child_process');

// Store active reminders
let activeReminders = new Map();

// Initialize notifications module
function initNotifications(db, mainWindow) {
  // Load reminders from database
  loadReminders(db, mainWindow);
  
  // Handler for creating a new reminder
  ipcMain.on('set-reminder', (event, reminder) => {
    saveReminder(db, reminder, mainWindow);
  });
  
  // Handler for completing a reminder
  ipcMain.on('complete-reminder', (event, reminderId) => {
    completeReminder(db, reminderId);
  });
  
  // Handler for deleting a reminder
  ipcMain.on('delete-reminder', (event, reminderId) => {
    deleteReminder(db, reminderId);
  });
  
  // Handler for loading all reminders for a specific note
  ipcMain.handle('get-note-reminders', (event, noteId) => {
    return getNoteReminders(db, noteId);
  });
}

// Load all active reminders from the database
function loadReminders(db, mainWindow) {
  try {
    // Clear existing reminders
    for (const timer of activeReminders.values()) {
      clearTimeout(timer);
    }
    activeReminders.clear();
    
    // Get all active reminders
    const now = Date.now();
    const reminders = db.prepare(`
      SELECT * FROM reminders 
      WHERE reminder_time > ? AND is_completed = 0
      ORDER BY reminder_time ASC
    `).all(now);
    
    // Set timers for each reminder
    reminders.forEach(reminder => {
      scheduleReminder(reminder, mainWindow);
    });
    
    console.log(`Loaded ${reminders.length} active reminders`);
  } catch (error) {
    console.error('Error loading reminders:', error);
  }
}

// Schedule a notification for a reminder
function scheduleReminder(reminder, mainWindow) {
  const now = Date.now();
  const delay = reminder.reminder_time - now;
  
  // Skip if time has passed
  if (delay <= 0) return;
  
  // Store reminder info for later access
  const reminderData = {
    reminder,
    mainWindow,
    dbReminderId: reminder.id
  };
  
  // Set timeout for the reminder
  const timerId = setTimeout(() => {
    showNotification(reminder, mainWindow);
    activeReminders.delete(reminderData.dbReminderId);
    
    // Get the main process module to access db
    const main = require('./main');
    main.completeReminderFromTimeout(reminderData.dbReminderId);
  }, delay);
  
  activeReminders.set(reminder.id, timerId);
}

// Show the notification
function showNotification(reminder, mainWindow) {
  try {
    // Get note title or use default
    const noteTitle = reminder.title || 'Note Reminder';
    const message = reminder.message || 'Don\'t forget about this note!';
    
    console.log('Showing notification:', noteTitle, message);
    
    // Create the notification with full absolute path to icon
    const iconPath = path.join(__dirname, 'assets/icon-3.png');
    console.log('Using icon path:', iconPath);
    
    // Check if we should play a sound
    const playSound = reminder.play_sound !== undefined ? 
                      reminder.play_sound : true;
    
    // Check if we should use urgent style
    const urgentStyle = reminder.urgent_style !== undefined ?
                     reminder.urgent_style : false;
    
    const notification = new Notification({
      title: noteTitle,
      body: message,
      icon: iconPath,
      silent: !playSound,
      urgency: urgentStyle ? 'critical' : 'normal',
      timeoutType: 'default'
    });
    
    // Show the notification
    notification.show();
    console.log('Notification shown');
    
    // Play custom sound if required (for Windows)
    if (playSound && process.platform === 'win32') {
      try {
        // Play system notification sound
        exec('powershell.exe [System.Media.SystemSounds]::Asterisk.Play()');
      } catch (e) {
        console.error('Failed to play sound:', e);
      }
    }
    
    // Open the note when notification is clicked
    notification.on('click', () => {
      console.log('Notification clicked, focusing window and opening note:', reminder.note_id);
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('open-note', reminder.note_id);
      }
    });
  } catch (error) {
    console.error('Error showing notification:', error);
  }
}

// Save a new reminder
function saveReminder(db, reminder, mainWindow) {
  try {
    const stmt = db.prepare(`
      INSERT INTO reminders (note_id, reminder_time, title, message, created_at, play_sound, urgent_style)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    const now = Date.now();
    const info = stmt.run(
      reminder.noteId,
      reminder.time,
      reminder.title || '',
      reminder.message || '',
      now,
      reminder.playSound ? 1 : 0,
      reminder.urgentStyle ? 1 : 0
    );
    
    // Get the new reminder with its ID
    const newReminder = {
      id: info.lastInsertRowid,
      note_id: reminder.noteId,
      reminder_time: reminder.time,
      title: reminder.title || '',
      message: reminder.message || '',
      is_completed: 0,
      created_at: now,
      play_sound: reminder.playSound ? 1 : 0,
      urgent_style: reminder.urgentStyle ? 1 : 0
    };
    
    // Schedule the reminder
    scheduleReminder(newReminder, mainWindow);
    
    return { success: true, id: info.lastInsertRowid };
  } catch (error) {
    console.error('Error saving reminder:', error);
    return { success: false, error: error.message };
  }
}

// Mark a reminder as completed
function completeReminder(db, reminderId) {
  try {
    // Clear active timer if exists
    if (activeReminders.has(reminderId)) {
      clearTimeout(activeReminders.get(reminderId));
      activeReminders.delete(reminderId);
    }
    
    // Update the database
    db.prepare(`
      UPDATE reminders SET is_completed = 1
      WHERE id = ?
    `).run(reminderId);
    
    return { success: true };
  } catch (error) {
    console.error('Error completing reminder:', error);
    return { success: false, error: error.message };
  }
}

// Delete a reminder
function deleteReminder(db, reminderId) {
  try {
    // Clear active timer if exists
    if (activeReminders.has(reminderId)) {
      clearTimeout(activeReminders.get(reminderId));
      activeReminders.delete(reminderId);
    }
    
    // Delete from database
    db.prepare(`
      DELETE FROM reminders WHERE id = ?
    `).run(reminderId);
    
    return { success: true };
  } catch (error) {
    console.error('Error deleting reminder:', error);
    return { success: false, error: error.message };
  }
}

// Get all reminders for a note
function getNoteReminders(db, noteId) {
  try {
    const reminders = db.prepare(`
      SELECT * FROM reminders 
      WHERE note_id = ? AND is_completed = 0
      ORDER BY reminder_time ASC
    `).all(noteId);
    
    return reminders;
  } catch (error) {
    console.error('Error fetching reminders:', error);
    return [];
  }
}

module.exports = {
  initNotifications
}; 