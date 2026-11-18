-- Headless access to PoB's passive power and Timeless Jewel data.
local M = {}
local SEARCH_TIME_BUDGET_SECONDS = 20

local function integer(value, default, min, max, name)
  if value == nil then return default end
  if type(value) ~= 'number' or value < min or value > max or value ~= math.floor(value) then
    error(name .. ' must be an integer between ' .. min .. ' and ' .. max, 0)
  end
  return value
end

local function findPowerStat(name)
  if type(name) ~= 'string' then error('stat must be a PoB metric name', 0) end
  local key = name:lower()
  local fallback
  for _, selection in ipairs(data.powerStatList or {}) do
    if selection.stat and not selection.ignoreForNodes then
      if selection.label:lower() == key then return selection end
      if selection.stat:lower() == key and not fallback then fallback = selection end
    end
  end
  if fallback then return fallback end
  error('Unknown Node Power stat: ' .. name .. '. Try FullDPS, TotalEHP, Life, or EnergyShield.', 0)
end

local function finite(value)
  return value == value and math.abs(value) < math.huge
end

local function collectNodePower(spec, depth)
  local rows = {}
  local nonFinite = 0
  for id, node in pairs(spec.nodes) do
    local power = node.power
    local distance = power.distance or node.pathDist
    if not node.alloc and not node.ascendancyName and distance and distance >= 1 and distance <= depth then
      local function add(effectId, label, values)
        if type(values.singleStat) ~= 'number' or type(values.pathPower) ~= 'number' then return end
        if not finite(values.singleStat) or not finite(values.pathPower) then
          nonFinite = nonFinite + 1
          return
        end
        if values.singleStat == 0 and values.pathPower == 0 then return end
        table.insert(rows, {
          nodeId = id, name = label, type = node.type, masteryEffectId = effectId,
          points = distance, nodeDelta = values.singleStat, pathDelta = values.pathPower,
          deltaPerPoint = values.pathPower / distance,
        })
      end
      if node.type == 'Mastery' then
        for effectId, values in pairs(power.masteryEffects or {}) do
          local effect = spec.tree.masteryEffects[effectId]
          if effect then add(effectId, node.dn .. ': ' .. table.concat(effect.sd or effect.stats or {}, ' / '), values) end
        end
      elseif node.type == 'Normal' or node.type == 'Notable' or node.type == 'Keystone' then
        add(nil, node.dn, power)
      end
    end
  end
  table.sort(rows, function(a, b)
    if a.deltaPerPoint ~= b.deltaPerPoint then return a.deltaPerPoint > b.deltaPerPoint end
    if a.nodeId ~= b.nodeId then return a.nodeId < b.nodeId end
    return (a.masteryEffectId or 0) < (b.masteryEffectId or 0)
  end)
  return rows, nonFinite
end

function M.get_node_power(params)
  local calcs = build and build.calcsTab
  local spec = build and build.spec
  if not spec or not calcs or not calcs.mainEnv then return nil, 'Load a build first' end
  if type(calcs.PowerBuilder) ~= 'function' then return nil, 'This PoB version has no Node Power calculator' end
  local selection = findPowerStat(params.stat)
  local depth = integer(params.max_depth, 5, 1, 15, 'max_depth')
  local limit = integer(params.limit, 15, 1, 50, 'limit')

  -- PoB writes transient scores to the nodes and the Calcs tab. Swap those
  -- tables out and restore them even if an upstream calculation fails.
  local savedPower = {}
  local function useScratch(nodes)
    for _, node in pairs(nodes or {}) do
      if not savedPower[node] then
        savedPower[node] = { value = node.power }
        node.power = {}
      end
    end
  end
  useScratch(spec.nodes)
  useScratch(spec.tree.clusterNodeMap)
  local oldStat, oldDepth = calcs.powerStat, calcs.nodePowerMaxDepth
  local oldMax, oldInitialized = calcs.powerMax, calcs.powerBuilderInitialized
  local oldProgress = build.powerBuilderProgressCallback
  local oldGetTime = GetTime
  calcs.powerStat, calcs.nodePowerMaxDepth, calcs.powerMax = selection, depth, nil
  build.powerBuilderProgressCallback = nil
  -- The headless graphics stub returns a constant. PowerBuilder uses this
  -- clock to yield between calculations so the bridge can enforce a budget.
  GetTime = function() return os.clock() * 1000 end
  local ok, rows, nonFinite = pcall(function()
    local job = coroutine.create(calcs.PowerBuilder)
    local started = os.clock()
    repeat
      local resumed, err = coroutine.resume(job, calcs)
      if not resumed then error(err, 0) end
      if os.clock() - started > SEARCH_TIME_BUDGET_SECONDS then
        error('Node Power calculation exceeded its time budget. Try a smaller max_depth.', 0)
      end
    until coroutine.status(job) == 'dead'
    return collectNodePower(spec, depth)
  end)
  for node, saved in pairs(savedPower) do node.power = saved.value end
  calcs.powerStat, calcs.nodePowerMaxDepth = oldStat, oldDepth
  calcs.powerMax, calcs.powerBuilderInitialized = oldMax, oldInitialized
  build.powerBuilderProgressCallback = oldProgress
  GetTime = oldGetTime
  if not ok then return nil, rows end

  local total = #rows
  for index = total, limit + 1, -1 do rows[index] = nil end
  return { stat = selection.stat, label = selection.label, maxDepth = depth, total = total, nonFinite = nonFinite, nodes = rows }
end

local jewelFamilies = {
  { prefix = 'vaal_', conquerors = { 'Doryani', 'Xibaqua', 'Mazcotl' } },
  { prefix = 'karui_', conquerors = { 'Kaom', 'Rakiata', 'Akoya' } },
  { prefix = 'maraketh_', conquerors = { 'Asenath', 'Nasima', 'Balbala' } },
  { prefix = 'templar_', conquerors = { 'Avarius', 'Dominus', 'Maxarius' } },
  { prefix = 'eternal_', conquerors = { 'Cadiro', 'Victario', 'Caspiro' } },
  { prefix = 'kalguur_', conquerors = { 'Vorana', 'Uhtred', 'Medved' } },
}

local function jewelSelection(params)
  local jewel = params.jewel
  if type(jewel) ~= 'string' then error('jewel must be a Timeless Jewel name', 0) end
  for id, family in ipairs(jewelFamilies) do
    local name = data.timelessJewelTypes[id]
    if name and name:lower() == jewel:lower() then
      local conqueror = params.conqueror
      if conqueror == nil then return id, name, family.prefix, 'Any' end
      if type(conqueror) ~= 'string' then error('conqueror must be a name', 0) end
      if conqueror:lower() == 'any' then return id, name, family.prefix, 'Any' end
      for _, candidate in ipairs(family.conquerors) do
        if candidate:lower() == conqueror:lower() then return id, name, family.prefix, candidate end
      end
      error('Unknown conqueror for ' .. name .. ': ' .. conqueror .. '. Choose ' .. table.concat(family.conquerors, ', ') .. '.', 0)
    end
  end
  error('Unsupported jewel: ' .. jewel .. '. Choose one of the six Timeless Jewels from Glorious Vanity through Heroic Tragedy.', 0)
end

local function desiredWeights(legion, prefix, desired)
  if type(desired) ~= 'table' or #desired == 0 or #desired > 12 then
    error('desired_mods must contain 1 to 12 modifier filters', 0)
  end
  local weights = {}
  for _, filter in ipairs(desired) do
    if type(filter) ~= 'table' or type(filter.mod) ~= 'string' or not filter.mod:find('%S') then
      error('Each desired mod needs a non-empty mod ID or text', 0)
    end
    local term = filter.mod:match('^%s*(.-)%s*$'):lower()
    local weight = filter.weight == nil and 1 or filter.weight
    if type(weight) ~= 'number' or not (weight > 0 and weight <= 1000) then
      error('Each modifier weight must be greater than 0 and at most 1000', 0)
    end
    local found = false
    local function indexModifiers(entries)
      for _, modifier in ipairs(entries) do
        if modifier.id:sub(1, #prefix) == prefix and not modifier.id:find('_keystone_', 1, true) then
          local text = table.concat(modifier.sd or {}, '\n'):lower()
          if modifier.id:lower() == term or text:find(term, 1, true) then
            found = true
            weights[modifier.id] = (weights[modifier.id] or 0) + weight
          end
        end
      end
    end
    indexModifiers(legion.nodes)
    indexModifiers(legion.additions)
    if not found then error('No modifier matches "' .. filter.mod .. '" for this jewel', 0) end
  end
  return weights
end

function M.find_timeless_jewel(params)
  local spec = build and build.spec
  if not spec then return nil, 'Load a build first' end
  local tree = spec.tree
  if not (tree.legion and data.timelessJewelTypes and data.readLUT and data.nodeIDList) then
    return nil, 'This PoB version has no Timeless Jewel lookup data'
  end
  local id, jewel, prefix, conqueror = jewelSelection(params)
  local socketId = integer(params.socket_node_id, nil, 1, 65535, 'socket_node_id')
  local socket = tree.nodes[socketId]
  if not socket or not socket.isJewelSocket then return nil, 'socket_node_id must identify a jewel socket in the active tree' end
  local limit = integer(params.limit, 10, 1, 30, 'limit')
  if params.include_unallocated ~= nil and type(params.include_unallocated) ~= 'boolean' then
    return nil, 'include_unallocated must be a boolean'
  end
  local weights = desiredWeights(tree.legion, prefix, params.desired_mods)
  local targets = {}
  local granted = build.calcsTab.mainEnv.grantedPassives or {}
  for nodeId in pairs(socket.nodesInRadius[3] or {}) do
    local node = tree.nodes[nodeId]
    local allocated = spec.allocNodes[nodeId] ~= nil or granted[nodeId] ~= nil
    if node and node.type == 'Notable' and data.nodeIDList[nodeId] and (allocated or params.include_unallocated) then
      table.insert(targets, { id = nodeId, name = node.dn, allocated = allocated })
    end
  end
  if #targets == 0 then return nil, 'No eligible notables in range. Try include_unallocated or choose a different socket.' end
  table.sort(targets, function(a, b) return a.id < b.id end)
  local additions, replacements = tree.legion.additions, tree.legion.nodes
  local cutoff = data.timelessJewelAdditions
  local step = id == 5 and 20 or 1
  local first, last = data.timelessJewelSeedMin[id] * step, data.timelessJewelSeedMax[id] * step
  local results, started = {}, os.clock()
  for seed = first, last, step do
    local score, matches = 0, {}
    for _, target in ipairs(targets) do
      local codes = data.readLUT(seed, target.id, id)
      if #codes == 0 then return nil, 'Missing Timeless Jewel lookup data for node ' .. target.id end
      -- Glorious Vanity stores rolled values after the replacement code, or
      -- pairs two arrays of addition codes and rolls for Might/Legacy.
      local count = #codes
      if id == 1 then count = (#codes >= 6) and #codes / 2 or 1 end
      for index = 1, count do
        local code = codes[index]
        local modifier = code >= cutoff and replacements[code + 1 - cutoff] or additions[code + 1]
        local weight = modifier and weights[modifier.id]
        if weight then
          score = score + weight
          table.insert(matches, {
            nodeId = target.id, nodeName = target.name, allocated = target.allocated,
            modId = modifier.id, stats = modifier.sd, weight = weight,
          })
        end
      end
    end
    if score > 0 then table.insert(results, { seed = seed, score = score, matches = matches }) end
    if os.clock() - started > SEARCH_TIME_BUDGET_SECONDS then return nil, 'Timeless Jewel search exceeded its time budget' end
  end
  table.sort(results, function(a, b)
    if a.score ~= b.score then return a.score > b.score end
    return a.seed < b.seed
  end)
  local total = #results
  for index = total, limit + 1, -1 do results[index] = nil end
  return {
    jewel = jewel, conqueror = conqueror, socketNodeId = socketId,
    socketAllocated = spec.allocNodes[socketId] ~= nil, notables = #targets,
    seedsScanned = (last - first) / step + 1, total = total, results = results,
  }
end

return M
