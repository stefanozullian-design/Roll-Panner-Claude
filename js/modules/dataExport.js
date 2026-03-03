// ─────────────────────────────────────────────────────────────────────────────
// dataExport.js — JSON backup/restore functionality for Roll Panner data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Export all application state as a JSON file download
 * @param {Object} state - The complete application state object
 * @param {string} filename - Optional filename (default: RollPanner_Backup_[timestamp].json)
 */
export function exportStateAsJSON(state, filename = null) {
  // Create metadata about the export
  const exportData = {
    // Backup metadata
    _backup: {
      version: 4,
      exportedAt: new Date().toISOString(),
      appVersion: '1.0.0',
      backupType: 'complete'
    },
    // Application state
    ...state
  };

  // Generate filename with timestamp if not provided
  if (!filename) {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    filename = `RollPanner_Backup_${timestamp}.json`;
  }

  // Convert to JSON string
  const jsonString = JSON.stringify(exportData, null, 2);

  // Create a Blob
  const blob = new Blob([jsonString], { type: 'application/json' });

  // Create download link
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;

  // Trigger download
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Clean up
  URL.revokeObjectURL(url);

  console.log(`[Export] State exported as ${filename}`);
  return { success: true, filename, size: blob.size };
}

/**
 * Export only the official dataset (no sandboxes)
 * Useful for sharing a snapshot of the primary dataset
 * @param {Object} state - The complete application state object
 * @param {string} filename - Optional filename
 */
export function exportOfficialOnly(state, filename = null) {
  const officialOnly = {
    _backup: {
      version: 4,
      exportedAt: new Date().toISOString(),
      appVersion: '1.0.0',
      backupType: 'official_only',
      note: 'Contains only Official dataset, excluding all sandboxes'
    },
    // Include only the official data
    official: state.official,
    logistics: state.logistics || { rulesOfEngagement: [], lanes: [] }
  };

  if (!filename) {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    filename = `RollPanner_Official_${timestamp}.json`;
  }

  const jsonString = JSON.stringify(officialOnly, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  console.log(`[Export] Official dataset exported as ${filename}`);
  return { success: true, filename, size: blob.size };
}

/**
 * Import state from a JSON file
 * @param {File} file - The JSON file to import
 * @returns {Promise<Object>} Parsed state object or null if invalid
 */
export async function importStateFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      try {
        const content = event.target.result;
        const data = JSON.parse(content);

        // Remove backup metadata if present
        const { _backup, ...restoreData } = data;

        // Log import info
        console.log('[Import] State imported successfully', {
          backupVersion: data._backup?.version,
          exportedAt: data._backup?.exportedAt,
          dataSize: JSON.stringify(restoreData).length
        });

        resolve(restoreData);
      } catch (err) {
        console.error('[Import] Failed to parse JSON file:', err);
        reject(new Error(`Invalid JSON file: ${err.message}`));
      }
    };

    reader.onerror = (err) => {
      console.error('[Import] Failed to read file:', err);
      reject(new Error('Failed to read file'));
    };

    reader.readAsText(file);
  });
}

/**
 * Get summary statistics about the current state
 * Useful for display before export
 * @param {Object} state - The application state
 * @returns {Object} Summary stats
 */
export function getStateStats(state) {
  const official = state.official || {};
  const sandboxes = state.sandboxes || {};

  return {
    facilities: (official.facilities || []).length,
    products: (official.products || []).length,
    equipment: (official.equipment || []).length,
    storages: (official.storages || []).length,
    recipes: (official.recipes || []).length,
    actuals: {
      inventoryBOD: (official.actuals?.inventoryBOD || []).length,
      production: (official.actuals?.production || []).length,
      shipments: (official.actuals?.shipments || []).length,
      transfers: (official.actuals?.transfers || []).length
    },
    sandboxCount: Object.keys(sandboxes).length,
    logisticsRules: (state.logistics?.rulesOfEngagement || []).length,
    logisticsLanes: (state.logistics?.lanes || []).length,
    estimatedSizeKB: (JSON.stringify(state).length / 1024).toFixed(2)
  };
}

/**
 * Create a human-readable summary of export contents
 * @param {Object} state - The application state
 * @returns {string} Formatted summary text
 */
export function getExportSummary(state) {
  const stats = getStateStats(state);

  return `
📊 Export Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Configuration:
  • Facilities: ${stats.facilities}
  • Products: ${stats.products}
  • Equipment: ${stats.equipment}
  • Storages: ${stats.storages}
  • Recipes: ${stats.recipes}

Actuals & Data:
  • Inventory BOD entries: ${stats.actuals.inventoryBOD}
  • Production entries: ${stats.actuals.production}
  • Shipment entries: ${stats.actuals.shipments}
  • Transfer entries: ${stats.actuals.transfers}

Scenarios:
  • Sandboxes: ${stats.sandboxCount}

Logistics:
  • Rules of Engagement: ${stats.logisticsRules}
  • Lanes: ${stats.logisticsLanes}

File Size: ~${stats.estimatedSizeKB} KB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();
}
