/**
 * RULES OF ENGAGEMENT - Centralized Hard-Coded Business Logic
 *
 * This file serves as the single source of truth for all hard-coded routing,
 * allocation, and configuration rules that cannot be determined by general algorithms.
 *
 * When new hard-coded logic is needed, add it here rather than scattered throughout
 * the codebase. This makes it easy to:
 * - Review all rules in one place
 * - Modify rules as business requirements change
 * - Add new facilities and their specific rules
 * - Audit what hard-coded logic exists and why
 *
 * ═════════════════════════════════════════════════════════════════════════════════
 */

const RulesOfEngagement = {

  // ═════════════════════════════════════════════════════════════════════════════
  // RECIPE VERSION SELECTION RULES
  // ═════════════════════════════════════════════════════════════════════════════
  // When an equipment produces a product with multiple recipe versions,
  // specify which version should be used.
  // This ensures consistent clinker sourcing and material routing.

  recipeVersionSelection: [
    {
      facility: 'BRS',
      product: 'region_FL|BRS_IL_12_BULK',
      description: 'BRS Finish Mills - IL 12 BULK cement routing',
      rules: [
        {
          equipmentId: 'BRS_BRSFM01',
          recipeVersion: 1,
          reason: 'FM01 uses recipe v1 which sources clinker from BRS_CLK_K1 (Kiln 1)'
        },
        {
          equipmentId: 'BRS_BRSFM02',
          recipeVersion: 2,
          reason: 'FM02 uses recipe v2 which sources clinker from BRS_CLK_K2 (Kiln 2)'
        }
      ]
    }
    // Add more recipe version rules for other facilities here
  ],

  // ═════════════════════════════════════════════════════════════════════════════
  // CLINKER SOURCE ROUTING RULES
  // ═════════════════════════════════════════════════════════════════════════════
  // Maps clinker products to their storage locations when multiple storages exist.
  // This ensures clinker is sourced from the correct kiln's inventory.

  clinkerSourceRouting: [
    {
      facility: 'BRS',
      description: 'BRS Clinker Storage Routing',
      mappings: [
        {
          clinkerProductId: 'BRS_CLK_K1',
          alternateProductId: 'region_FL|BRS_CLK_K1',
          storageId: 'BRS_BRS_INV_CLK_BRSK01',
          kiln: 'K1',
          reason: 'Clinker from Kiln 1 is stored in BRSK01'
        },
        {
          clinkerProductId: 'BRS_CLK_K2',
          alternateProductId: 'region_FL|BRS_CLK_K2',
          storageId: 'BRS_BRS_INV_CLK_BRSK02',
          kiln: 'K2',
          reason: 'Clinker from Kiln 2 is stored in BRSK02'
        }
      ]
    }
    // Add more clinker routing rules for other facilities here
  ],

  // ═════════════════════════════════════════════════════════════════════════════
  // EQUIPMENT-TO-KILN ASSOCIATION RULES
  // ═════════════════════════════════════════════════════════════════════════════
  // Maps equipment to preferred kiln sources for future use cases.

  equipmentKilnPreference: [
    {
      facility: 'BRS',
      description: 'BRS Finish Mill to Kiln Associations',
      associations: [
        {
          equipmentId: 'BRS_BRSFM01',
          preferredKiln: 'BRS_BRSKL01',
          clinkerStorage: 'BRS_BRS_INV_CLK_BRSK01',
          reason: 'FM01 primarily consumes clinker from Kiln 1'
        },
        {
          equipmentId: 'BRS_BRSFM02',
          preferredKiln: 'BRS_BRSKL02',
          clinkerStorage: 'BRS_BRS_INV_CLK_BRSK02',
          reason: 'FM02 primarily consumes clinker from Kiln 2'
        }
      ]
    }
    // Add more equipment associations for other facilities here
  ],

  // ═════════════════════════════════════════════════════════════════════════════
  // EQUIPMENT RUN/IDLE BEHAVIOR RULES
  // ═════════════════════════════════════════════════════════════════════════════
  // Defines minimum run duration, idle duration, and restart conditions.
  // Prevents inefficient on/off cycling while maintaining responsive operation.

  equipmentRunIdleRules: [
    {
      equipmentType: 'kiln',
      minRunDays: 15,
      minIdleDays: 0,
      restartCondition: {
        type: 'inventoryBuffer',
        bufferDays: 15,
        description: 'Restart when storage has 15+ days buffer before hitting max capacity'
      },
      reason: 'Kilns are expensive to start/stop; require longer run times for efficiency'
    },
    {
      equipmentType: 'finish_mill',
      minRunDays: 2,
      minIdleDays: 0,
      restartCondition: {
        type: 'inventoryBuffer',
        bufferDays: 15,
        description: 'Restart when clinker/cement storage has 15+ days buffer before hitting max capacity'
      },
      reason: 'Mills are more flexible; can start/stop more frequently but still need minimum stability'
    }
    // Add more equipment types as needed
  ],

  // ═════════════════════════════════════════════════════════════════════════════
  // UTILITY FUNCTIONS
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Get recipe version for specific equipment and product
   * @param {string} facilityId - Facility ID (e.g., 'BRS')
   * @param {string} productId - Product ID (e.g., 'region_FL|BRS_IL_12_BULK')
   * @param {string} equipmentId - Equipment ID (e.g., 'BRS_BRSFM01')
   * @returns {number|null} Recipe version number or null if no rule found
   */
  getRecipeVersion(facilityId, productId, equipmentId) {
    const rule = this.recipeVersionSelection.find(r =>
      r.facility === facilityId && r.product === productId
    );
    if (!rule) return null;

    const equipmentRule = rule.rules.find(e => e.equipmentId === equipmentId);
    return equipmentRule ? equipmentRule.recipeVersion : null;
  },

  /**
   * Get storage location for clinker product
   * @param {string} facilityId - Facility ID
   * @param {string} clinkerProductId - Clinker product ID
   * @returns {string|null} Storage ID or null if no mapping found
   */
  getClilinkerStorage(facilityId, clinkerProductId) {
    const routingRule = this.clinkerSourceRouting.find(r => r.facility === facilityId);
    if (!routingRule) return null;

    const mapping = routingRule.mappings.find(m =>
      m.clinkerProductId === clinkerProductId || m.alternateProductId === clinkerProductId
    );
    return mapping ? mapping.storageId : null;
  },

  /**
   * Get preferred kiln for equipment
   * @param {string} facilityId - Facility ID
   * @param {string} equipmentId - Equipment ID
   * @returns {string|null} Kiln ID or null if no preference defined
   */
  getPreferredKiln(facilityId, equipmentId) {
    const assocRule = this.equipmentKilnPreference.find(r => r.facility === facilityId);
    if (!assocRule) return null;

    const assoc = assocRule.associations.find(a => a.equipmentId === equipmentId);
    return assoc ? assoc.preferredKiln : null;
  },

  /**
   * Get run/idle rules for equipment type
   * @param {string} equipmentType - 'kiln' or 'finish_mill'
   * @returns {object|null} Rule object or null if no rule found
   */
  getRunIdleRule(equipmentType) {
    return this.equipmentRunIdleRules.find(r => r.equipmentType === equipmentType);
  },

  /**
   * Calculate if equipment can restart based on inventory buffer calculation
   * Formula: (Max Storage Capacity - Current BOD Inventory) / (Avg 10-day consumption - Max Production capacity) >= required buffer days
   * @param {number} maxStorageCapacity - Silo max capacity (STn)
   * @param {number} currentBODInventory - Beginning of day inventory (STn)
   * @param {number} avgLast10DaysConsumption - Rolling 10-day average consumption (STn/day)
   * @param {number} maxProductionCapacity - Equipment max production rate (STn/day)
   * @param {number} requiredBufferDays - Minimum buffer days required (default 15)
   * @returns {boolean} True if equipment can restart
   */
  canRestartBasedOnBuffer(maxStorageCapacity, currentBODInventory, avgLast10DaysConsumption, maxProductionCapacity, requiredBufferDays = 15) {
    // Check if we have valid input
    if (maxStorageCapacity <= 0 || requiredBufferDays <= 0) return true;

    const availableHeadroom = maxStorageCapacity - currentBODInventory;
    const netConsumption = avgLast10DaysConsumption - maxProductionCapacity;

    // If consumption is less than/equal to production, no restart issue
    if (netConsumption <= 0) {
      return true;
    }

    // Calculate days of buffer available
    const daysOfBuffer = availableHeadroom / netConsumption;
    return daysOfBuffer >= requiredBufferDays;
  },

  /**
   * Get all rules for a facility
   * @param {string} facilityId - Facility ID
   * @returns {object} All rules defined for this facility
   */
  getRulesForFacility(facilityId) {
    return {
      recipeVersionSelection: this.recipeVersionSelection.filter(r => r.facility === facilityId),
      clinkerSourceRouting: this.clinkerSourceRouting.filter(r => r.facility === facilityId),
      equipmentKilnPreference: this.equipmentKilnPreference.filter(r => r.facility === facilityId),
      equipmentRunIdleRules: this.equipmentRunIdleRules  // Global rules, applied to all facilities
    };
  },

  /**
   * Print all rules to console for audit/review
   */
  printAllRules() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('RULES OF ENGAGEMENT - All Hard-Coded Business Logic');
    console.log('═══════════════════════════════════════════════════════════════');

    console.log('\n[RECIPE VERSION SELECTION]');
    this.recipeVersionSelection.forEach(rule => {
      console.log(`  Facility: ${rule.facility}, Product: ${rule.product}`);
      rule.rules.forEach(eq => {
        console.log(`    → ${eq.equipmentId} uses recipe v${eq.recipeVersion}: ${eq.reason}`);
      });
    });

    console.log('\n[CLINKER SOURCE ROUTING]');
    this.clinkerSourceRouting.forEach(rule => {
      console.log(`  Facility: ${rule.facility}`);
      rule.mappings.forEach(m => {
        console.log(`    → ${m.clinkerProductId} → ${m.storageId} (${m.reason})`);
      });
    });

    console.log('\n[EQUIPMENT-TO-KILN ASSOCIATIONS]');
    this.equipmentKilnPreference.forEach(rule => {
      console.log(`  Facility: ${rule.facility}`);
      rule.associations.forEach(a => {
        console.log(`    → ${a.equipmentId} → ${a.preferredKiln} (${a.reason})`);
      });
    });
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RulesOfEngagement;
}
