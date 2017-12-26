import Big from 'big.js'
import { v4 as uuid } from 'uuid'

import {
  all,
  call,
  fork,
  put,
  select,
  take,
  takeEvery
} from 'redux-saga/effects'

import { requestPayment } from '../../lib/fetch-monero'

import {
  getSettings
} from '../reducers'

import {
  updatePayment
} from '../actions/payments'

import * as types from '../actions/constants/payments'

const { fetch } = window

function * waitForPayment (id, paymentRequest) {
  const onFulfilled = yield call([paymentRequest, 'onFulfilled'])
  yield put(updatePayment(id, { receivedAmount: new Big(onFulfilled.amountReceived).div(1e12).toFixed(12) }))
}

function * listenForTip (id, paymentRequest, name, receipt) {
  while (true) {
    const setTip = yield take(types.SET_TIP)
    const { tip } = setTip.payload
    const convertedTip = parseInt(new Big(tip).times(1e12).round(), 10)
    const { uri } = yield call([paymentRequest, 'makeUri'], convertedTip, name, receipt)
    yield put(updatePayment(id, { tip, uri }))
  }
}

export function * processPayment (action) {
  const {
    resolve
  } = action.payload

  const settings = yield select(getSettings)

  const walletUrl = settings.walletUrl || 'https://testnet.kasisto.io:28084/json_rpc'
  const fiatCurrency = settings.fiatCurrency || 'EUR'
  const merchantName = settings.name || 'Coffee shop'

  const id = uuid()

  // create the initial payment in the store
  yield put(updatePayment(id, { fiatCurrency }))

  yield call(resolve, id)

  const [rate, paymentRequest] = yield all([
    call(fetchExchangeRate, fiatCurrency),
    call(requestPayment, walletUrl)
  ])

  const {
    address,
    height,
    paymentId
  } = paymentRequest

  yield put(updatePayment(id, { address, height, paymentId, rate }))

  const setAmount = yield take(types.SET_AMOUNT)

  const { requestedAmount, receipt } = setAmount.payload
  const convertedAmount = new Big(requestedAmount).times(1e12).div(rate).round()

  yield put(updatePayment(id, {
    requestedAmount,
    convertedAmount: convertedAmount.div(1e12).toFixed(12),
    receipt
  }))

  paymentRequest.setAmount(parseInt(convertedAmount, 10))

  const { uri } = yield call([paymentRequest, 'makeUri'], 0, merchantName, receipt)
  yield put(updatePayment(id, { uri }))

  yield fork(waitForPayment, id, paymentRequest)
  yield fork(listenForTip, id, paymentRequest, merchantName, receipt)
}

export function * watchCreatePayment () {
  yield takeEvery(types.REQUEST_PAYMENT, processPayment)
}

const fetchExchangeRate = (fiatCurrency) => {
  if (fiatCurrency === null) {
    return Promise.resolve(1)
  } else {
    // return fetch('https://api.kraken.com/0/public/Ticker?pair=xmreur,xmrusd')
    //   .then(response => response.json())
    //   .then(json => Number.parseFloat(json.result[`XXMRZ${fiatCurrency}`]['p'][1]))
    return fetch(`https://api.coinmarketcap.com/v1/ticker/monero/?convert=${fiatCurrency}`)
      .then(response => response.json())
      .then(json => Number.parseFloat(json[0][`price_${fiatCurrency.toLowerCase()}`]))
  }
}
