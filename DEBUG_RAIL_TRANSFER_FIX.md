# Rail Transfer Actuals Issue - Root Cause & Fix

## Problem Statement
User reported that values entered in the Daily Actuals form for rail transfer on 01/02/25 (Cars Loaded, Cars Picked Up, EOD) were not appearing in the Production Plan table.

## Investigation Results

### Data Analysis (from JSON backup)
The JSON backup file (`RollPanner_Backup_2026-03-06T05-29-09.json`) revealed:
- **railTransfers array**: **EMPTY** (line 9683)
- **railInventoryEod array**: Has values for 01/01 (2240 STn) and 01/02 (3360 STn)

This indicated that EOD values were being saved but loading/pickup actuals were NOT being saved at all.

### System Configuration (from JSON)
The facility "BRS" had:
- **Rail Transfer Storage**: `BRS_BRS_RAIL_BRS_IL_BULK` (lines 1015-1023)
  - categoryHint: "TRANSFER"
  - allowedProductIds: ["region_FL|BRS_IL_12_BULK"]
  - maxCapacityStn: 5000

- **Rail Equipment**:
  - Loader: `BRS_BRS_RAIL_LOADING` (line 809)
  - Switch: `BRS_BRS_SWITCH` (line 815)

- **Product**: `region_FL|BRS_IL_12_BULK`

### Code Analysis

**File: js/core-app.js (Lines 3843-3850)**

**The Bug:**
```javascript
if (carsLoaded !== '' && carsLoaded !== null && +carsLoaded > 0) {
  railTransferRows.push({type:'loading', qtyStn: +carsLoaded * 112});
}
if (carsPicked !== '' && carsPicked !== null && +carsPicked > 0) {
  railTransferRows.push({type:'pickup', qtyStn: +carsPicked * 112});
}
```

The form was creating rows with only `type` and `qtyStn`, but **missing `equipmentId` and `productId`**.

**File: js/modules/dataAuthority.js (Lines 822-826)**

**The Validation:**
```javascript
if (r.equipmentId && r.productId && isFinite(r.qtyStn) && +r.qtyStn !== 0) {
  ds.actuals.railTransfers.push({
    date, facilityId: fid, type: r.type || 'loading',
    equipmentId: r.equipmentId, productId: r.productId, qtyStn: +r.qtyStn
  });
}
```

The save function **requires equipmentId and productId** for non-EOD rows. Since the form wasn't providing them, these rows were silently discarded.

## Root Cause
**Mismatch between form submission and save validation:**
- Form collected data with insufficient fields
- Save function rejected incomplete data
- No error feedback to user
- EOD rows saved successfully because they don't require equipment/product
- Loading/pickup rows silently rejected, appearing as if "not saved"

## The Fix

**File: js/core-app.js (Lines 3834-3859)**

Added code to dynamically determine equipment IDs and product ID:

```javascript
// Rail Transfer: Get equipment IDs and product ID from facility configuration
const loaderEq = s.equipment.find(e=>e.type==='loader');
const switchEq = s.equipment.find(e=>e.type==='switch');
const railStorage = s.storages.find(st=>st.categoryHint==='TRANSFER');
const railProductId = railStorage?.allowedProductIds?.[0] || '';
```

Updated row creation to include these fields:

```javascript
if (carsLoaded !== '' && carsLoaded !== null && +carsLoaded > 0) {
  if (loaderEq?.id && railProductId) {
    railTransferRows.push({
      type:'loading',
      equipmentId:loaderEq.id,
      productId:railProductId,
      qtyStn: +carsLoaded * 112
    });
  }
}

if (carsPicked !== '' && carsPicked !== null && +carsPicked > 0) {
  if (switchEq?.id && railProductId) {
    railTransferRows.push({
      type:'pickup',
      equipmentId:switchEq.id,
      productId:railProductId,
      qtyStn: +carsPicked * 112
    });
  }
}
```

## How It Works Now

1. **Form opens** - gets the current facility ID
2. **Form builds** - looks up:
   - Loader equipment (type='loader')
   - Switch equipment (type='switch')
   - Rail transfer storage (categoryHint='TRANSFER')
   - Rail product ID (from storage's allowedProductIds)
3. **User enters data** - Cars Loaded, Cars Picked Up, EOD Cars
4. **User saves** - Form submits railTransferRows WITH:
   - Loading: {type:'loading', equipmentId:loader_id, productId:rail_product_id, qtyStn:value}
   - Pickup: {type:'pickup', equipmentId:switch_id, productId:rail_product_id, qtyStn:value}
   - EOD: {type:'eod', qtyStn:value}
5. **Save function accepts** - All fields present, rows are saved to railTransfers array
6. **Plan displays** - Simulation engine processes saved data and displays in plan table

## Testing Checklist

- [ ] Open Daily Actuals form for BRS facility
- [ ] Enter: Cars Loaded = 5, Cars Picked = 2, EOD = 10
- [ ] Save
- [ ] Check browser console - no errors
- [ ] Check Plan page - verify values appear in RAIL TRANSFER section
- [ ] Verify formula: EOD = BOD + Loading - Pickup

## Files Changed
- `js/core-app.js` - Lines 3834-3859 (rail transfer row creation)

## Related Code
- `js/modules/dataAuthority.js` - Lines 777-847 (saveDailyActuals function with validation)
- `js/modules/simEngine.js` - Lines 410-426 (rail transfer processing in simulation)

---

**Commit Hash**: 5644779
**Date Fixed**: 2026-03-06
