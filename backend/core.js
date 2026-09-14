import { validateEAN, validateTgInitData, logger, getCountryByPrefix } from './utils.js';
import { searchAllDatabases } from './barcodeService.js';
import { findBestWbOffer, getWbPriceByArticle } from './wildberriesService.js';
import {
  getStaticCache,
  setStaticCache,
  getDynamicCache,
  setDynamicCache,
  getNegativeCache,
  setNegativeCache,
  acquireLock,
  releaseLock
} from './redisService.js';
import { CONFIG } from './config.js';

export async function handleProductRequest(barcode, tgInitData, botToken, emit) {
  if (botToken && tgInitData) {
    const isValid = await validateTgInitData(tgInitData, botToken);
    if (!isValid) {
      emit('error', { error: 'unauthorized', message: 'Unauthorized' });
      return;
    }
  }

  let cleanBarcode = (barcode || '').trim().replace(/\D/g, '');

  if (cleanBarcode.length === 12) {
    cleanBarcode = '0' + cleanBarcode;
  }

  if (!validateEAN(cleanBarcode)) {
    emit('error', { error: 'invalid_barcode', message: 'Invalid barcode' });
    return;
  }

  try {
    const staticData = await getStaticCache(cleanBarcode);
    if (staticData) {
      emit('status', { message: 'Определяем товар…' });
      const dynamicData = await getDynamicCache(staticData.wildberries.article);
      if (dynamicData) {
        emit('status', { message: 'Найдено' });
        staticData.wildberries.price = dynamicData.price;
        staticData.wildberries.oldPrice = dynamicData.oldPrice;
        staticData.wildberries.rating = dynamicData.rating;
        staticData.wildberries.reviewsCount = dynamicData.reviewsCount;
        const ourPriceRaw = dynamicData.price * CONFIG.DISCOUNT_MULTIPLIER;
        staticData.ourPrice = Math.round(ourPriceRaw * 100) / 100;
        staticData.updatedAt = Date.now();
        emit('result', staticData);
        return;
      }

      emit('status', { message: 'Обновляем цену…' });
      const wbDynamicInfo = await getWbPriceByArticle(staticData.wildberries.article);

      if (wbDynamicInfo) {
        await setDynamicCache(staticData.wildberries.article, wbDynamicInfo);
        emit('status', { message: 'Найдено' });
        staticData.wildberries.price = wbDynamicInfo.price;
        staticData.wildberries.oldPrice = wbDynamicInfo.oldPrice;
        staticData.wildberries.rating = wbDynamicInfo.rating;
        staticData.wildberries.reviewsCount = wbDynamicInfo.reviewsCount;
        const ourPriceRaw = wbDynamicInfo.price * CONFIG.DISCOUNT_MULTIPLIER;
        staticData.ourPrice = Math.round(ourPriceRaw * 100) / 100;
        staticData.updatedAt = Date.now();
        emit('result', staticData);
        return;
      } else {
        emit('status', { message: 'Найдено (сохраненная цена)' });
        staticData.updatedAt = Date.now();
        emit('result', staticData);
        return;
      }
    }

    const negative = await getNegativeCache(cleanBarcode);
    if (negative) {
      if (negative.error === 'not_found_on_wb') {
        emit('error', {
          error: 'not_found_on_wb',
          sourceProduct: negative.sourceProduct,
          barcode: cleanBarcode
        });
      } else {
        emit('error', {
          error: 'Not found in databases',
          barcode: cleanBarcode,
          country: getCountryByPrefix(cleanBarcode)
        });
      }
      return;
    }

    const lockKey = `barcode:${cleanBarcode}`;
    const locked = await acquireLock(lockKey, CONFIG.CACHE_LOCK_TTL);
    if (!locked) {
      emit('error', { error: 'duplicate_request', message: 'Поиск уже выполняется' });
      return;
    }

    try {
      emit('status', { message: 'Определяем товар…' });
      const { productData, hasUpstreamSuccess } = await searchAllDatabases(cleanBarcode);

      if (!productData) {
        if (hasUpstreamSuccess) {
          await setNegativeCache(cleanBarcode, {
            error: 'not_found_in_db',
            ts: Date.now()
          });
          emit('error', {
            error: 'Not found in databases',
            barcode: cleanBarcode,
            country: getCountryByPrefix(cleanBarcode)
          });
        } else {
          emit('error', {
            error: 'temporary_error',
            message: 'Databases unavailable',
            barcode: cleanBarcode
          });
        }
        return;
      }

      emit('status', { message: 'Ищем на Wildberries…' });
      emit('status', { message: 'Сравниваем предложения…' });

      const wbResult = await findBestWbOffer(productData, cleanBarcode);

      if (wbResult.error) {
        if (wbResult.error === 'not_found' || wbResult.error === 'no_relevant') {
          await setNegativeCache(cleanBarcode, {
            error: 'not_found_on_wb',
            sourceProduct: {
              name: productData.name,
              brand: productData.brand,
              image: productData.image
            },
            ts: Date.now()
          });
          emit('error', {
            error: 'not_found_on_wb',
            sourceProduct: productData,
            barcode: cleanBarcode
          });
        } else {
          emit('error', {
            error: wbResult.error,
            message: 'Wildberries error',
            barcode: cleanBarcode
          });
        }
        return;
      }

      const finalResult = {
        barcode: cleanBarcode,
        country: getCountryByPrefix(cleanBarcode),
        sourceProduct: {
          name: productData.name,
          brand: productData.brand,
          image: productData.image
        },
        wildberries: wbResult,
        ourPrice: wbResult.ourPrice,
        updatedAt: Date.now()
      };

      await setStaticCache(cleanBarcode, finalResult);
      await setDynamicCache(wbResult.article, {
        price: wbResult.price,
        oldPrice: wbResult.oldPrice,
        rating: wbResult.rating,
        reviewsCount: wbResult.reviewsCount
      });

      emit('status', { message: 'Найдено' });
      emit('result', finalResult);
    } finally {
      await releaseLock(lockKey);
    }

  } catch (err) {
    logger('error', 'Process Error', { barcode: cleanBarcode, error: err.message });
    emit('error', { error: 'server_error', message: 'Server error' });
  }
}