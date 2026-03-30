'use strict';

const ShopGoodwillSource = require('./shopGoodwillSource');
const GovDealsSource = require('./govDealsSource');
const PropertyRoomSource = require('./propertyRoomSource');
const BidSpotterSource = require('./bidSpotterSource');

/**
 * Create and return all enabled auction sources based on config.
 *
 * @param {object} auctionSourcesConfig - The auctionSources config block from config.js
 * @returns {BaseAuctionSource[]}
 */
function createSources(auctionSourcesConfig) {
  const cfg = auctionSourcesConfig || {};

  return [
    new ShopGoodwillSource(cfg.shopGoodwill || {}),
    new GovDealsSource(cfg.govDeals || {}),
    new PropertyRoomSource(cfg.propertyRoom || {}),
    new BidSpotterSource(cfg.bidSpotter || {}),
  ].filter((source) => source.enabled);
}

module.exports = {
  BaseAuctionSource: require('./baseSource'),
  ShopGoodwillSource,
  GovDealsSource,
  PropertyRoomSource,
  BidSpotterSource,
  createSources,
};
