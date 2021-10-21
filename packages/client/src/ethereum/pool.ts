import BigNumber from "bignumber.js"
import {fetchDataFromAttributes, getPoolEvents, INTEREST_DECIMALS, USDC_DECIMALS} from "./utils"
import {Tickers, usdcFromAtomic} from "./erc20"
import {FIDU_DECIMALS, sharesToBalance, balanceInDollars} from "./fidu"
import {getBlockInfo, getCurrentBlock, roundDownPenny, BlockInfo} from "../utils"
import _ from "lodash"
import {getBalanceAsOf, mapEventsToTx} from "./events"
import {Contract, EventData} from "web3-eth-contract"
import {Pool as PoolContract} from "@goldfinch-eng/protocol/typechain/web3/Pool"
import {SeniorPool as SeniorPoolContract} from "@goldfinch-eng/protocol/typechain/web3/SeniorPool"
import {StakingRewards as StakingRewardsContract} from "@goldfinch-eng/protocol/typechain/web3/StakingRewards"
import {Fidu as FiduContract} from "@goldfinch-eng/protocol/typechain/web3/Fidu"
import {GoldfinchProtocol} from "./GoldfinchProtocol"
import {TranchedPool} from "@goldfinch-eng/protocol/typechain/web3/TranchedPool"
import {buildCreditLine} from "./creditLine"
import {getMetadataStore} from "./tranchedPool"
import {BlockNumber} from "web3-core"

class Pool {
  goldfinchProtocol: GoldfinchProtocol
  contract: PoolContract
  chain: string
  address: string
  loaded: boolean

  constructor(goldfinchProtocol: GoldfinchProtocol) {
    this.goldfinchProtocol = goldfinchProtocol
    this.contract = goldfinchProtocol.getContract<PoolContract>("Pool")
    this.address = goldfinchProtocol.getAddress("Pool")
    this.chain = goldfinchProtocol.networkId
    this.loaded = true
  }
}

class SeniorPool {
  goldfinchProtocol: GoldfinchProtocol
  contract: SeniorPoolContract
  usdc: Contract
  fidu: FiduContract
  v1Pool: Pool
  chain: string
  address: string
  _loaded: boolean
  gf!: PoolData
  isPaused!: boolean

  constructor(goldfinchProtocol: GoldfinchProtocol) {
    this.goldfinchProtocol = goldfinchProtocol
    this.contract = goldfinchProtocol.getContract<SeniorPoolContract>("SeniorPool")
    this.address = goldfinchProtocol.getAddress("SeniorPool")
    this.usdc = goldfinchProtocol.getERC20(Tickers.USDC).contract
    this.fidu = goldfinchProtocol.getContract<FiduContract>("Fidu")
    this.v1Pool = new Pool(goldfinchProtocol)
    this.chain = goldfinchProtocol.networkId
    this._loaded = true
  }

  async initialize() {
    let poolData = await fetchPoolData(this, this.usdc)
    this.gf = poolData
    this.isPaused = await this.contract.methods.paused().call()
  }

  async getPoolEvents(
    address: string | undefined,
    eventNames: string[] = ["DepositMade", "WithdrawalMade"],
    includeV1Pool: boolean = true,
    toBlock: BlockNumber = "latest"
  ): Promise<EventData[]> {
    if (includeV1Pool) {
      // In migrating from v1 to v2 (i.e. from the `Pool` contract as modeling the senior pool,
      // to the `SeniorPool` contract as modeling the senior pool), we transferred contract state
      // from Pool to SeniorPool (e.g. the capital supplied by a capital provider to Pool
      // became capital supplied by that provider to SeniorPool). But we did not do any sort of
      // migrating (e.g. re-emitting) with respect to events, from the Pool contract onto the
      // SeniorPool contract. So fully representing the SeniorPool's events here -- e.g. to be
      // able to accurately count all of a capital provider's supplier capital -- entails querying
      // for those events on both the SeniorPool and Pool contracts.

      const events = await Promise.all([
        getPoolEvents(this, address, eventNames, toBlock),
        getPoolEvents(this.v1Pool, address, eventNames, toBlock),
      ])
      const combined = _.flatten(events)
      return combined
    } else {
      return getPoolEvents(this, address, eventNames, toBlock)
    }
  }

  get loaded(): boolean {
    return this._loaded && this.v1Pool.loaded
  }
}

interface CapitalProvider {
  shares: {
    parts: {
      notStaked: BigNumber
      stakedNotLocked: BigNumber
      stakedLocked: BigNumber
    }
    aggregates: {
      staked: BigNumber
      withdrawable: BigNumber
      total: BigNumber
    }
  }
  stakedSeniorPoolBalanceInDollars: BigNumber
  totalSeniorPoolBalanceInDollars: BigNumber
  availableToStakeInDollars: BigNumber
  availableToWithdraw: BigNumber
  availableToWithdrawInDollars: BigNumber
  address: string
  allowance: BigNumber
  weightedAverageSharePrice: BigNumber
  unrealizedGains: BigNumber
  unrealizedGainsInDollars: BigNumber
  unrealizedGainsPercentage: BigNumber
  loaded: boolean
  empty?: boolean
}

function emptyCapitalProvider({loaded = false} = {}): CapitalProvider {
  return {
    shares: {
      parts: {
        notStaked: new BigNumber(0),
        stakedNotLocked: new BigNumber(0),
        stakedLocked: new BigNumber(0),
      },
      aggregates: {
        staked: new BigNumber(0),
        withdrawable: new BigNumber(0),
        total: new BigNumber(0),
      },
    },
    stakedSeniorPoolBalanceInDollars: new BigNumber(0),
    totalSeniorPoolBalanceInDollars: new BigNumber(0),
    availableToStakeInDollars: new BigNumber(0),
    availableToWithdraw: new BigNumber(0),
    availableToWithdrawInDollars: new BigNumber(0),
    address: "",
    allowance: new BigNumber(0),
    weightedAverageSharePrice: new BigNumber(0),
    unrealizedGains: new BigNumber(0),
    unrealizedGainsInDollars: new BigNumber(0),
    unrealizedGainsPercentage: new BigNumber(0),
    loaded,
    empty: true,
  }
}

type CapitalProviderStaked = {
  numSharesStakedLocked: BigNumber
  numSharesStakedNotLocked: BigNumber
}

async function fetchCapitalProviderStaked(
  stakingRewards: StakingRewards,
  capitalProviderAddress: string,
  currentBlock: BlockInfo
): Promise<CapitalProviderStaked> {
  const numPositions = parseInt(
    await stakingRewards.contract.methods.balanceOf(capitalProviderAddress).call(undefined, currentBlock.number),
    10
  )
  const tokenIds: string[] = await Promise.all(
    Array(numPositions)
      .fill("")
      .map((val, i) =>
        stakingRewards.contract.methods
          .tokenOfOwnerByIndex(capitalProviderAddress, i)
          .call(undefined, currentBlock.number)
      )
  )
  const positions = await Promise.all(
    tokenIds.map((tokenId) => stakingRewards.contract.methods.positions(tokenId).call(undefined, currentBlock.number))
  )
  const staked = positions.map((position) => ({
    amount: new BigNumber(position.amount),
    locked: new BigNumber(position.lockedUntil).gt(0),
  }))
  const locked = staked.filter((val) => val.locked)
  const notLocked = staked.filter((val) => !val.locked)
  return {
    numSharesStakedLocked: locked.length
      ? BigNumber.sum.apply(
          null,
          locked.map((val) => val.amount)
        )
      : new BigNumber(0),
    numSharesStakedNotLocked: notLocked.length
      ? BigNumber.sum.apply(
          null,
          notLocked.map((val) => val.amount)
        )
      : new BigNumber(0),
  }
}

async function fetchCapitalProviderData(
  pool: SeniorPool,
  stakingRewards: StakingRewards | undefined,
  capitalProviderAddress: string | undefined
): Promise<CapitalProvider> {
  if (!stakingRewards) {
    return emptyCapitalProvider({loaded: false})
  }
  if (!capitalProviderAddress) {
    return emptyCapitalProvider({loaded: pool.loaded && stakingRewards.loaded})
  }

  const currentBlock = getBlockInfo(await getCurrentBlock())
  const attributes = [{method: "sharePrice"}]
  const {sharePrice} = await fetchDataFromAttributes(pool.contract, attributes, {
    bigNumber: true,
    blockNumber: currentBlock.number,
  })

  const numSharesNotStaked = new BigNumber(
    await pool.fidu.methods.balanceOf(capitalProviderAddress).call(undefined, currentBlock.number)
  )
  const {numSharesStakedLocked, numSharesStakedNotLocked} = await fetchCapitalProviderStaked(
    stakingRewards,
    capitalProviderAddress,
    currentBlock
  )

  const numSharesStaked = numSharesStakedLocked.plus(numSharesStakedNotLocked)
  const numSharesWithdrawable = numSharesNotStaked.plus(numSharesStakedNotLocked)
  const numSharesTotal = numSharesNotStaked.plus(numSharesStakedLocked).plus(numSharesStakedNotLocked)

  const stakedSeniorPoolBalance = sharesToBalance(numSharesStaked, sharePrice)
  const stakedSeniorPoolBalanceInDollars = balanceInDollars(stakedSeniorPoolBalance)

  const totalSeniorPoolBalance = sharesToBalance(numSharesTotal, sharePrice)
  const totalSeniorPoolBalanceInDollars = balanceInDollars(totalSeniorPoolBalance)

  const availableToStake = sharesToBalance(numSharesNotStaked, sharePrice)
  const availableToStakeInDollars = balanceInDollars(availableToStake)

  const availableToWithdraw = sharesToBalance(numSharesWithdrawable, sharePrice)
  const availableToWithdrawInDollars = balanceInDollars(availableToWithdraw)

  const address = capitalProviderAddress
  const allowance = new BigNumber(
    await pool.usdc.methods.allowance(capitalProviderAddress, pool.address).call(undefined, currentBlock.number)
  )
  const weightedAverageSharePrice = await getWeightedAverageSharePrice(
    pool,
    stakingRewards,
    capitalProviderAddress,
    numSharesTotal,
    currentBlock
  )
  const sharePriceDelta = sharePrice.dividedBy(FIDU_DECIMALS).minus(weightedAverageSharePrice)
  const unrealizedGains = sharePriceDelta.multipliedBy(numSharesTotal)
  const unrealizedGainsInDollars = new BigNumber(roundDownPenny(unrealizedGains.div(FIDU_DECIMALS)))
  const unrealizedGainsPercentage = sharePriceDelta.dividedBy(weightedAverageSharePrice)
  const loaded = true

  return {
    shares: {
      parts: {
        notStaked: numSharesNotStaked,
        stakedNotLocked: numSharesStakedNotLocked,
        stakedLocked: numSharesStakedLocked,
      },
      aggregates: {
        staked: numSharesStaked,
        withdrawable: numSharesWithdrawable,
        total: numSharesTotal,
      },
    },
    stakedSeniorPoolBalanceInDollars,
    totalSeniorPoolBalanceInDollars,
    availableToStakeInDollars,
    availableToWithdraw,
    availableToWithdrawInDollars,
    address,
    allowance,
    weightedAverageSharePrice,
    unrealizedGains,
    unrealizedGainsInDollars,
    unrealizedGainsPercentage,
    loaded,
  }
}

interface PoolData {
  rawBalance: BigNumber
  compoundBalance: BigNumber
  balance: BigNumber
  totalShares: BigNumber
  totalPoolAssets: BigNumber
  totalLoansOutstanding: BigNumber
  cumulativeWritedowns: BigNumber
  cumulativeDrawdowns: BigNumber
  estimatedTotalInterest: BigNumber
  estimatedApy: BigNumber
  estimatedApyFromGfi: BigNumber | undefined
  defaultRate: BigNumber
  poolEvents: EventData[]
  assetsAsOf: typeof assetsAsOf
  getRepaymentEvents: typeof getRepaymentEvents
  remainingCapacity: typeof remainingCapacity
  loaded: boolean
  pool: SeniorPool
}

async function fetchPoolData(pool: SeniorPool, erc20: Contract): Promise<PoolData> {
  // TODO We should probably use a consistent block number for all the calls in this method.
  const attributes = [{method: "sharePrice"}, {method: "compoundBalance"}]
  let {sharePrice, compoundBalance: _compoundBalance} = await fetchDataFromAttributes(pool.contract, attributes)
  let rawBalance = new BigNumber(await erc20.methods.balanceOf(pool.address).call())
  let compoundBalance = new BigNumber(_compoundBalance)
  let balance = compoundBalance.plus(rawBalance)
  let totalShares = new BigNumber(await pool.fidu.methods.totalSupply().call())

  // Do some slightly goofy multiplication and division here so that we have consistent units across
  // 'balance', 'totalPoolBalance', and 'totalLoansOutstanding', allowing us to do arithmetic between them
  // and display them using the same helpers.
  const totalPoolAssetsInDollars = totalShares
    .div(FIDU_DECIMALS.toString())
    .multipliedBy(new BigNumber(sharePrice))
    .div(FIDU_DECIMALS.toString())
  let totalPoolAssets = totalPoolAssetsInDollars.multipliedBy(USDC_DECIMALS.toString())
  let totalLoansOutstanding = new BigNumber(await pool.contract.methods.totalLoansOutstanding().call())
  let cumulativeWritedowns = await getCumulativeWritedowns(pool)
  let cumulativeDrawdowns = await getCumulativeDrawdowns(pool)
  let poolEvents = await getAllDepositAndWithdrawalEvents(pool)
  let estimatedTotalInterest = await getEstimatedTotalInterest(pool)
  let estimatedApy = estimatedTotalInterest.dividedBy(totalPoolAssets)
  // TODO Calculate this value using Uniswap price oracle for GFI, once that becomes available.
  const estimatedApyFromGfi = undefined
  let defaultRate = cumulativeWritedowns.dividedBy(cumulativeDrawdowns)

  let loaded = true

  return {
    rawBalance,
    compoundBalance,
    balance,
    totalShares,
    totalPoolAssets,
    totalLoansOutstanding,
    cumulativeWritedowns,
    cumulativeDrawdowns,
    poolEvents,
    assetsAsOf,
    getRepaymentEvents,
    remainingCapacity,
    estimatedTotalInterest,
    estimatedApy,
    estimatedApyFromGfi,
    defaultRate,
    loaded,
    pool,
  }
}

type StakedEventsByBlockNumberAndTxIndex = {
  [blockNumber: number]: {
    [txIndex: number]: EventData
  }
}

async function getDepositEventsForCapitalProvider(
  pool: SeniorPool,
  stakingRewards: StakingRewards,
  capitalProviderAddress: string,
  currentBlock: BlockInfo
): Promise<EventData[]> {
  const depositEventsByCapitalProviderDirectly: EventData[] = await pool.getPoolEvents(
    capitalProviderAddress,
    ["DepositMade"],
    true,
    currentBlock.number
  )

  // TODO Getting all deposit events by the StakingRewards contract seems likely to become inefficient rapidly.
  // We should invert the approach and get only those in block numbers for which there was a Staked event for
  // `capitalProviderAddress`, which will be much fewer in number.
  const depositEventsViaStakingRewards: EventData[] = await pool.getPoolEvents(
    stakingRewards.address,
    ["DepositMade"],
    // No events from the v1 Pool contract could correspond to Staked events (because the StakingRewards
    // contract did not exist until after the migration to the v2 SeniorPool contract), so we can exclude them,
    // for efficiency.
    false,
    currentBlock.number
  )
  const stakedEventsForCapitalProvider: EventData[] = await stakingRewards.getStakedEvents(
    capitalProviderAddress,
    currentBlock
  )
  const stakedEventsForCapitalProviderByBlockNumberAndTxIndex =
    stakedEventsForCapitalProvider.reduce<StakedEventsByBlockNumberAndTxIndex>((acc, curr) => {
      const eventsByTxIndex = acc[curr.blockNumber]
      if (eventsByTxIndex && curr.transactionIndex in eventsByTxIndex) {
        throw new Error("Expected at most one Staked event per transaction hash.")
      }
      return {
        ...acc,
        [curr.blockNumber]: {
          ...eventsByTxIndex,
          [curr.transactionIndex]: curr,
        },
      }
    }, {})
  const depositEventsByCapitalProviderViaStakingRewards: EventData[] = depositEventsViaStakingRewards.filter(
    (depositEvent: EventData): boolean => {
      const stakedEventsByTxIndex = stakedEventsForCapitalProviderByBlockNumberAndTxIndex[depositEvent.blockNumber]
      const correspondingStakedEvent = stakedEventsByTxIndex
        ? stakedEventsByTxIndex[depositEvent.transactionIndex]
        : undefined
      if (correspondingStakedEvent) {
        if (depositEvent.returnValues.shares === correspondingStakedEvent.returnValues.amount) {
          return true
        } else {
          throw new Error(
            `Staked event in block ${correspondingStakedEvent.blockNumber} tx ${correspondingStakedEvent.transactionIndex} \`amount\` corresponding to DepositMade event differs from \`shares\`.`
          )
        }
      } else {
        return false
      }
    }
  )

  return depositEventsByCapitalProviderDirectly.concat(depositEventsByCapitalProviderViaStakingRewards)
}

// This uses the FIFO method of calculating cost-basis. Thus we
// add up the deposits *in reverse* to arrive at your current number of shares.
// We calculate the weighted average price based on that, which can then be used
// to calculate unrealized gains.
// NOTE: This does not take into account transfers of Fidu that happen outside
// the protocol. In such a case, you would necessarily end up with more Fidu (in
// the case of net inbound transfers; or less Fidu, in the case of net outbound transfers)
// than we have records of your deposits, so we would not be able to account
// for your shares, and we would fail out, and return a "-" on the front-end.
// NOTE: This also does not take into account realized gains, which we are also
// punting on.
async function getWeightedAverageSharePrice(
  pool: SeniorPool,
  stakingRewards: StakingRewards,
  capitalProviderAddress: string,
  capitalProviderTotalShares: BigNumber,
  currentBlock: BlockInfo
) {
  const depositEvents = await getDepositEventsForCapitalProvider(
    pool,
    stakingRewards,
    capitalProviderAddress,
    currentBlock
  )
  const preparedEvents = _.reverse(_.sortBy(depositEvents, ["blockNumber", "transactionIndex"]))

  let zero = new BigNumber(0)
  let sharesLeftToAccountFor = capitalProviderTotalShares
  let totalAmountPaid = zero
  preparedEvents.forEach((event) => {
    if (sharesLeftToAccountFor.lte(zero)) {
      return
    }
    const sharePrice = new BigNumber(event.returnValues.amount)
      .dividedBy(USDC_DECIMALS.toString())
      .dividedBy(new BigNumber(event.returnValues.shares).dividedBy(FIDU_DECIMALS.toString()))
    const sharesToAccountFor = BigNumber.min(sharesLeftToAccountFor, new BigNumber(event.returnValues.shares))
    totalAmountPaid = totalAmountPaid.plus(sharesToAccountFor.multipliedBy(sharePrice))
    sharesLeftToAccountFor = sharesLeftToAccountFor.minus(sharesToAccountFor)
  })
  if (sharesLeftToAccountFor.gt(zero)) {
    // This case means you must have received Fidu outside of depositing,
    // which we don't have price data for, and therefore can't calculate
    // a correct weighted average price. By returning empty string,
    // the result becomes NaN, and our display functions automatically handle
    // the case, and turn it into a '-' on the front-end
    return new BigNumber("")
  } else {
    return totalAmountPaid.dividedBy(capitalProviderTotalShares)
  }
}

async function getCumulativeWritedowns(pool: SeniorPool) {
  // In theory, we'd also want to include `PrincipalWrittendown` events emitted by `pool.v1Pool` here.
  // But in practice, we don't need to, because only one such was emitted, due to a bug which was
  // then fixed. So we include only `PrincipalWrittenDown` events emitted by `pool`.

  const events = await pool.goldfinchProtocol.queryEvents(pool.contract, "PrincipalWrittenDown")
  const sum: BigNumber = events.length
    ? BigNumber.sum.apply(
        null,
        events.map((eventData) => new BigNumber(eventData.returnValues.amount))
      )
    : new BigNumber(0)
  return sum.negated()
}

async function getCumulativeDrawdowns(pool: SeniorPool) {
  const protocol = pool.goldfinchProtocol
  const tranchedPoolAddresses = await getTranchedPoolAddressesForSeniorPoolCalc(pool)
  const tranchedPools = tranchedPoolAddresses.map((address) =>
    protocol.getContract<TranchedPool>("TranchedPool", address)
  )
  let allDrawdownEvents = _.flatten(
    await Promise.all(tranchedPools.map((pool) => protocol.queryEvents(pool, "DrawdownMade")))
  )
  const sum: BigNumber = allDrawdownEvents.length
    ? BigNumber.sum.apply(
        null,
        allDrawdownEvents.map((eventData) => new BigNumber(eventData.returnValues.amount))
      )
    : new BigNumber(0)
  return sum
}

async function getRepaymentEvents(this: PoolData, goldfinchProtocol: GoldfinchProtocol) {
  const eventNames = ["InterestCollected", "PrincipalCollected", "ReserveFundsCollected"]
  let events = await goldfinchProtocol.queryEvents(this.pool.contract, eventNames)
  const oldEvents = await goldfinchProtocol.queryEvents("Pool", eventNames)
  events = oldEvents.concat(events)
  const eventTxs = await mapEventsToTx(events)
  const combinedEvents = _.map(_.groupBy(eventTxs, "id"), (val) => {
    const interestPayment = _.find(val, (event) => event.type === "InterestCollected")
    const principalPayment = _.find(val, (event) => event.type === "PrincipalCollected") || {
      amountBN: new BigNumber(0),
    }
    const reserveCollection = _.find(val, (event) => event.type === "ReserveFundsCollected") || {
      amountBN: new BigNumber(0),
    }
    if (!interestPayment) {
      // This usually  means it's just ReserveFundsCollected, from a withdraw, and not a repayment
      return null
    }
    const merged: any = {...interestPayment, ...principalPayment, ...reserveCollection}
    merged.amountBN = interestPayment.amountBN.plus(principalPayment.amountBN).plus(reserveCollection.amountBN)
    merged.amount = usdcFromAtomic(merged.amountBN)
    merged.interestAmountBN = interestPayment.amountBN
    merged.type = "CombinedRepayment"
    merged.name = "CombinedRepayment"
    return merged
  })
  return _.compact(combinedEvents)
}

async function getAllDepositAndWithdrawalEvents(pool: SeniorPool): Promise<EventData[]> {
  const eventNames = ["DepositMade", "WithdrawalMade"]
  const poolEvents = await pool.getPoolEvents(undefined, eventNames)
  return poolEvents
}

function assetsAsOf(this: PoolData, blockNumExclusive: number): BigNumber {
  return getBalanceAsOf(this.poolEvents, blockNumExclusive, "WithdrawalMade")
}

/**
 * Returns the remaining capacity in the pool, assuming a max capacity of `maxPoolCapacity`,
 * in atomic units.
 *
 * @param maxPoolCapacity - Maximum capacity of the pool
 * @returns Remaining capacity of pool in atomic units
 */
function remainingCapacity(this: PoolData, maxPoolCapacity: BigNumber): BigNumber {
  let cappedBalance = BigNumber.min(this.totalPoolAssets, maxPoolCapacity)
  return new BigNumber(maxPoolCapacity).minus(cappedBalance)
}

async function getEstimatedTotalInterest(pool: SeniorPool): Promise<BigNumber> {
  const protocol = pool.goldfinchProtocol
  const tranchedPoolAddresses = await getTranchedPoolAddressesForSeniorPoolCalc(pool)
  const tranchedPools = tranchedPoolAddresses.map((address) =>
    protocol.getContract<TranchedPool>("TranchedPool", address)
  )
  const creditLineAddresses = await Promise.all(tranchedPools.map((p) => p.methods.creditLine().call()))
  const creditLines = creditLineAddresses.map((a) => buildCreditLine(a))
  const creditLineData = await Promise.all(
    creditLines.map(async (cl) => {
      let balance = new BigNumber(await cl.methods.balance().call())
      let interestApr = new BigNumber(await cl.methods.interestApr().call())
      return {balance, interestApr}
    })
  )
  return BigNumber.sum.apply(
    null,
    creditLineData.map((cl) => cl.balance.multipliedBy(cl.interestApr.dividedBy(INTEREST_DECIMALS.toString())))
  )
}

/**
 * Helper that provides the addresses of the comprehensive set of tranched pools to compute
 * over when performing a calculation relating to the senior pool.
 *
 * @param pool - The senior pool.
 * @returns The set of tranched pool addresses.
 */
async function getTranchedPoolAddressesForSeniorPoolCalc(pool: SeniorPool): Promise<string[]> {
  const protocol = pool.goldfinchProtocol
  const [metadataStore, investmentEvents] = await Promise.all([
    getMetadataStore(protocol.networkId),
    protocol.queryEvents(pool.contract, ["InvestmentMadeInSenior", "InvestmentMadeInJunior"]),
  ])
  // In migrating to v2, we did not emit InvestmentMadeInJunior events for the tranched pools that we
  // migrated from v1 (we just minted them position tokens directly). So we need to supplement how we
  // identify the tranched pools to use in doing a calculation for the senior pool, by explicitly
  // including those that were migrated.
  const migratedTranchedPoolAddresses: string[] = Object.keys(metadataStore).filter(
    (address: string) => metadataStore[address]?.migrated
  )
  const eventsTranchedPoolAddresses: string[] = investmentEvents.map((e) => e.returnValues.tranchedPool)
  // De-duplicate the tranched pool addresses, in case investment events have subsequently been emitted
  // relating to tranched pools that were migrated, or in case there has been more than one investment
  // event for a tranched pool.
  const tranchedPoolAddresses = _.uniq(migratedTranchedPoolAddresses.concat(eventsTranchedPoolAddresses))
  return tranchedPoolAddresses
}

interface Rewards {
  totalUnvested: BigNumber
  totalVested: BigNumber
  totalPreviouslyVested: BigNumber
  totalClaimed: BigNumber
  startTime: number
  endTime: number
}

class StakedPosition {
  tokenId: string
  amount: BigNumber
  leverageMultiplier: BigNumber
  lockedUntil: number
  rewards: Rewards
  claimable: BigNumber

  constructor(
    tokenId: string,
    amount: BigNumber,
    leverageMultiplier: BigNumber,
    lockedUntil: number,
    claimable: BigNumber,
    rewards: Rewards
  ) {
    this.tokenId = tokenId
    this.amount = amount
    this.leverageMultiplier = leverageMultiplier
    this.lockedUntil = lockedUntil
    this.rewards = rewards
    this.claimable = claimable
  }

  get reason(): string {
    const fiduAmount = this.amount.div(FIDU_DECIMALS.toString())
    const date = new Date(this.rewards.startTime * 1000).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })
    return `Staked ${fiduAmount} FIDU on ${date}`
  }

  get granted(): BigNumber {
    return this.rewards.totalUnvested.plus(this.rewards.totalVested).plus(this.rewards.totalPreviouslyVested)
  }
}

function parseStakedPosition(
  tokenId: string,
  claimable: string,
  tuple: {0: string; 1: [string, string, string, string, string, string]; 2: string; 3: string}
): StakedPosition {
  return new StakedPosition(
    tokenId,
    new BigNumber(tuple[0]),
    new BigNumber(tuple[2]),
    parseInt(tuple[3], 10),
    new BigNumber(claimable),
    {
      totalUnvested: new BigNumber(tuple[1][0]),
      totalVested: new BigNumber(tuple[1][1]),
      totalPreviouslyVested: new BigNumber(tuple[1][2]),
      totalClaimed: new BigNumber(tuple[1][3]),
      startTime: parseInt(tuple[1][4], 10),
      endTime: parseInt(tuple[1][5], 10),
    }
  )
}

class StakingRewards {
  goldfinchProtocol: GoldfinchProtocol
  contract: StakingRewardsContract
  address: string
  loaded: boolean
  isPaused: boolean
  positions: StakedPosition[] | undefined
  totalClaimable: BigNumber | undefined
  unvested: BigNumber | undefined
  granted: BigNumber | undefined

  constructor(goldfinchProtocol: GoldfinchProtocol) {
    this.goldfinchProtocol = goldfinchProtocol
    this.contract = goldfinchProtocol.getContract<StakingRewardsContract>("StakingRewards")
    this.address = goldfinchProtocol.getAddress("StakingRewards")
    this.loaded = false
    this.isPaused = false
  }

  async initialize(recipient: string) {
    const currentBlock = getBlockInfo(await getCurrentBlock())
    this.isPaused = await this.contract.methods.paused().call(undefined, currentBlock.number)

    // NOTE: In defining `this.positions`, we want to use `balanceOf()` plus `tokenOfOwnerByIndex()`
    // to determine `tokenIds`, rather than using the set of Staked events for the `recipient`.
    // The former approach reflects any token transfers that may have occurred to or from the
    // `recipient`, whereas the latter does not.
    const numPositions = parseInt(
      await this.contract.methods.balanceOf(recipient).call(undefined, currentBlock.number),
      10
    )
    const tokenIds: string[] = await Promise.all(
      Array(numPositions)
        .fill("")
        .map((val, i) => this.contract.methods.tokenOfOwnerByIndex(recipient, i).call(undefined, currentBlock.number))
    )
    this.positions = await Promise.all(
      tokenIds.map((tokenId) => {
        return this.contract.methods
          .positions(tokenId)
          .call(undefined, currentBlock.number)
          .then(async (res) => {
            const claimable = await this.contract.methods.claimableRewards(tokenId).call(undefined, currentBlock.number)
            return parseStakedPosition(tokenId, claimable, res)
          })
      })
    )
    this.totalClaimable = this.calculateTotalClaimable()
    this.unvested = this.calculateUnvested()
    this.granted = this.calculateGranted()
    this.loaded = true
  }

  async getStakedEvents(recipient: string, currentBlock: BlockInfo): Promise<EventData[]> {
    const eventNames = ["Staked"]
    const events = await this.goldfinchProtocol.queryEvents(
      this.contract,
      eventNames,
      {user: recipient},
      currentBlock.number
    )
    return events
  }

  calculateTotalClaimable(): BigNumber {
    if (!this.positions || this.positions.length === 0) return new BigNumber(0)
    return BigNumber.sum.apply(
      null,
      this.positions.map((stakedPosition) => stakedPosition.claimable)
    )
  }

  calculateUnvested(): BigNumber {
    if (!this.positions || this.positions.length === 0) return new BigNumber(0)
    return BigNumber.sum.apply(
      null,
      this.positions.map((stakedPosition) => stakedPosition.rewards.totalUnvested)
    )
  }

  calculateGranted(): BigNumber {
    if (!this.positions || this.positions.length === 0) return new BigNumber(0)
    return BigNumber.sum.apply(
      null,
      this.positions.map((stakedPosition) =>
        stakedPosition.rewards.totalUnvested
          .plus(stakedPosition.rewards.totalVested)
          .plus(stakedPosition.rewards.totalPreviouslyVested)
      )
    )
  }
}

export {fetchCapitalProviderData, fetchPoolData, SeniorPool, Pool, emptyCapitalProvider, StakingRewards, StakedPosition}
export type {PoolData, CapitalProvider}
