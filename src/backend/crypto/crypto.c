/**
 * Seashell's cryptographic communications backend.
 * Copyright (C) 2013 The Seashell Maintainers.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * See also 'ADDITIONAL TERMS' at the end of the included LICENSE file.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>. 
 */
#include <tomcrypt.h>
#include <stdint.h>
#include <stdio.h>

/** Implementor's note - these functions are not thread safe. */

int err = CRYPT_OK;
prng_state prng = {0};

/**
 * seashell_crypt_setup (void)
 * Sets up Seashell's cryptographic backend code.
 *
 * This function must be called before any cryptographic
 * code is used.
 *
 * Returns:
 * 1 on failure, 0 on success.
 */
int seashell_crypt_setup(void)
{
  if(register_cipher(&aes_desc) == -1)
    return 1;
  if(register_hash(&sha256_desc) == -1)
    return 1;
  if(register_prng(&fortuna_desc) == -1)
    return 1;
  if((err = rng_make_prng(256, find_prng("fortuna"),
          &prng, NULL)) != CRYPT_OK)
    return 1;
  return 0;
}

/**
 * seashell_crypt_error (void)
 * Returns the last error that happened.
 */
const char* seashell_crypt_error (void) {
  return error_to_string(err);
}

/**
 * seashell_encrypt (
 *  const uint8_t key[16],
 *  const uint8_t iv[12],
 *  const uint8_t* plain,
 *  uint32_t plain_len,
 *  const uint8_t* auth,
 *  uint32_t auth_len,
 *  [OUT] uint8_t* coded,
 *  [OUT] uint8_t tag[16],
 *
 * Given a key [128-bits], initialization vector
 * [96-bits] and plaintext,
 * encrypts the plaintext using AES-128 in the
 * Galois Counter Mode of encryption.  The result
 * is written to coded [same length as plain],
 * and tag, which is assumed to be a 16-byte buffer.
 *
 * auth holds the plaintext authenticated data.
 *
 * Returns 0 on success, 1 on failure.
 */
int seashell_encrypt (
    const uint8_t key[16],
    const uint8_t iv[12],
    const uint8_t* plain,
    const uint32_t plain_len,
    const uint8_t* auth,
    const uint32_t auth_len,
    uint8_t* coded,
    uint8_t tag[16]) {

  unsigned long tag_len = 16;
  err = gcm_memory(
      find_cipher("aes"),
      key, 16,
      iv, 12,
      auth, auth_len,
      (uint8_t*)plain, plain_len,
      coded,
      tag, &tag_len,
      GCM_ENCRYPT);

  return !(err == CRYPT_OK);
}

/**
 * seashell_decrypt (
 *  const uint8_t key[16],
 *  const uint8_t iv[12],
 *  [OUT] uint8_t* plain,
 *  uint32_t plain_len,
 *  const uint8_t* auth,
 *  uint32_t auth_len,
 *  const uint8_t* coded,
 *  const uint8_t tag[16],
 *
 * Given a key [128-bits], initialization vector
 * [96-bits], ciphertext, and authenticated data,
 * decrypts the ciphertext and verifies using
 * AES-128 in the Galois Counter Mode of operation.
 *
 * Returns 0 on success, 1 on failure.
 */
int seashell_decrypt (
    const uint8_t key[16],
    const uint8_t iv[12],
    uint8_t* plain,
    const uint32_t plain_len,
    const uint8_t* auth,
    const uint32_t auth_len,
    const uint8_t* coded,
    const uint8_t tag[16]) {

  unsigned long tag_len = 16;
  err = gcm_memory(
      find_cipher("aes"),
      key, 16,
      iv, 12,
      auth, auth_len,
      plain, plain_len,
      (uint8_t*)coded,
      (uint8_t*)tag, &tag_len,
      GCM_DECRYPT);

  return !(err == CRYPT_OK);
}

/**
 * seashell_make_iv (uint8_t iv[12])
 * Generates a IV up to 12 bytes in length.
 * Returns:
 *  Number of bytes actually read.
 */
int seashell_make_iv (uint8_t iv[12]) {
  unsigned long len = 12;
  return fortuna_read(iv, len, &prng);
}

/**
 * seashell_make_key (uint8_t key[16])
 * Generates a encryption key 16-bytes long.
 * Returns:
 *  Number of bytes actually set.
 */
int seashell_make_key (uint8_t key[16]) {
  unsigned long len = 16;
  return rng_read_bytes(key, &len, NULL);
}