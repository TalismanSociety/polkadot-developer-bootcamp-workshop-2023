//
// These classes live in https://github.com/TalismanSociety/talisman/blob/a916db00770851e75c6d8b03af1b6767ced4e8c8/packages/balances/src/helpers.ts#L213-L415
// They've been copied here for demonstration purposes.
//

import { StorageKey, decorateStorage } from "@polkadot/types"
import type { Registry } from "@polkadot/types-codec/types"
import { SubscriptionCallback, UnsubscribeFn } from "@talismn/balances"
import { ChainConnector } from "@talismn/chain-connector"
import { ChainId } from "@talismn/chaindata-provider"
import { hasOwnProperty } from "@talismn/util"
import groupBy from "lodash/groupBy"

/**
 * Used by a variety of balance modules to help encode and decode substrate state calls.
 */
export class StorageHelper {
  #registry
  #storageKey

  #module
  #method
  #parameters

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags: any = null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(registry: Registry, module: string, method: string, ...parameters: any[]) {
    this.#registry = registry

    this.#module = module
    this.#method = method
    this.#parameters = parameters

    const _metadataVersion = 0 // is not used inside the decorateStorage function
    let query
    try {
      query = decorateStorage(registry, registry.metadata, _metadataVersion)
    } catch (error) {
      console.debug(`Failed to decorate storage: ${(error as Error).message}`)
      this.#storageKey = null
    }

    try {
      if (!query) throw new Error(`decoratedStorage unavailable`)
      this.#storageKey = new StorageKey(
        registry,
        parameters ? [query[module][method], parameters] : query[module][method]
      )
    } catch (error) {
      console.debug(
        `Failed to create storageKey ${module || "unknown"}.${method || "unknown"}: ${(error as Error).message}`
      )
      this.#storageKey = null
    }
  }

  get stateKey() {
    return this.#storageKey?.toHex()
  }

  get module() {
    return this.#module
  }
  get method() {
    return this.#method
  }
  get parameters() {
    return this.#parameters
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tag(tags: any) {
    this.tags = tags
    return this
  }

  decode(input?: string | null) {
    if (!this.#storageKey) return
    return this.#decodeStorageScaleResponse(this.#registry, this.#storageKey, input)
  }

  #decodeStorageScaleResponse(typeRegistry: Registry, storageKey: StorageKey, input?: string | null) {
    if (input === undefined || input === null) return

    const type = storageKey.outputType || "Raw"
    const meta = storageKey.meta || {
      fallback: undefined,
      modifier: { isOptional: true },
      type: { asMap: { linked: { isTrue: false } }, isMap: false },
    }

    try {
      return typeRegistry.createTypeUnsafe(
        type,
        [meta.modifier.isOptional ? typeRegistry.createTypeUnsafe(type, [input], { isPedantic: true }) : input],
        { isOptional: meta.modifier.isOptional, isPedantic: !meta.modifier.isOptional }
      )
    } catch (error) {
      throw new Error(
        `Unable to decode storage ${storageKey.section || "unknown"}.${storageKey.method || "unknown"}: ${
          (error as Error).message
        }`
      )
    }
  }
}

/**
 * Pass some these into an `RpcStateQueryHelper` in order to easily batch multiple state queries into the one rpc call.
 */
export type RpcStateQuery<T> = {
  chainId: string
  stateKey: string
  decodeResult: (change: string | null) => T
}

/**
 * Used by a variety of balance modules to help batch multiple state queries into the one rpc call.
 */
export class RpcStateQueryHelper<T> {
  #chainConnector: ChainConnector
  #queries: Array<RpcStateQuery<T>>

  constructor(chainConnector: ChainConnector, queries: Array<RpcStateQuery<T>>) {
    this.#chainConnector = chainConnector
    this.#queries = queries
  }

  async subscribe(
    callback: SubscriptionCallback<T[]>,
    timeout: number | false = false,
    subscribeMethod = "state_subscribeStorage",
    responseMethod = "state_storage",
    unsubscribeMethod = "state_unsubscribeStorage"
  ): Promise<UnsubscribeFn> {
    const queriesByChain = groupBy(this.#queries, "chainId")

    const subscriptions = Object.entries(queriesByChain).map(([chainId, queries]) => {
      const params = [queries.map(({ stateKey }) => stateKey)]

      const unsub = this.#chainConnector.subscribe(
        chainId,
        subscribeMethod,
        responseMethod,
        params,
        (error, result) => {
          error ? callback(error) : callback(null, this.#distributeChangesToQueryDecoders.call(this, chainId, result))
        },
        timeout
      )

      return () => unsub.then((unsubscribe) => unsubscribe(unsubscribeMethod))
    })

    return () => subscriptions.forEach((unsubscribe) => unsubscribe())
  }

  async fetch(method = "state_queryStorageAt"): Promise<T[]> {
    const queriesByChain = groupBy(this.#queries, "chainId")

    const resultsByChain = await Promise.all(
      Object.entries(queriesByChain).map(async ([chainId, queries]) => {
        const params = [queries.map(({ stateKey }) => stateKey)]

        const result = (await this.#chainConnector.send(chainId, method, params))[0]
        return this.#distributeChangesToQueryDecoders.call(this, chainId, result)
      })
    )

    return resultsByChain.flatMap((result) => result)
  }

  #distributeChangesToQueryDecoders(chainId: ChainId, result: unknown): T[] {
    if (typeof result !== "object" || result === null) return []
    if (!hasOwnProperty(result, "changes") || typeof result.changes !== "object") return []
    if (!Array.isArray(result.changes)) return []

    return result.changes.flatMap(([reference, change]: [unknown, unknown]): [T] | [] => {
      if (typeof reference !== "string") {
        console.warn(`Received non-string reference in RPC result: ${reference}`)
        return []
      }

      if (typeof change !== "string" && change !== null) {
        console.warn(`Received non-string and non-null change in RPC result: ${reference} | ${change}`)
        return []
      }

      const query = this.#queries.find(({ chainId: cId, stateKey }) => cId === chainId && stateKey === reference)
      if (!query) {
        console.warn(`Failed to find query:\n${reference} in\n${this.#queries.map(({ stateKey }) => stateKey)}`)
        return []
      }

      return [query.decodeResult(change)]
    })
  }
}
