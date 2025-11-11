;; hedao-token.clar
;; HEDAO Governance Token - SIP-010 FT with minting, staking, and reward mechanics

(define-constant CONTRACT-OWNER tx-sender)
(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INSUFFICIENT-BALANCE u101)
(define-constant ERR-INVALID-AMOUNT u102)
(define-constant ERR-ALREADY-STAKED u103)
(define-constant ERR-NOT-STAKED u104)
(define-constant ERR-STAKE-LOCKED u105)
(define-constant ERR-REWARD-CALC-FAIL u106)
(define-constant ERR-MINT-LIMIT-EXCEEDED u107)
(define-constant ERR-ZERO-ADDRESS u108)

(define-fungible-token hedao-token)

(define-data-var total-supply uint u100000000000000) ;; 100M tokens, 6 decimals
(define-data-var mint-cap uint u100000000000000)
(define-data-var token-name (string-ascii 32) "HEDAO Governance Token")
(define-data-var token-symbol (string-ascii 10) "HEDAO")
(define-data-var token-decimals uint u6)
(define-data-var last-global-reward-block uint u0)
(define-data-var reward-per-block uint u1000000) ;; 1 token per block
(define-data-var accumulated-reward-per-share uint u0)

(define-map stakes
  principal
  { amount: uint, reward-debt: uint, last-claim-block: uint, lock-until: uint }
)

(define-map minters principal bool)

(define-read-only (get-name)
  (ok (var-get token-name))
)

(define-read-only (get-symbol)
  (ok (var-get token-symbol))
)

(define-read-only (get-decimals)
  (ok (var-get token-decimals))
)

(define-read-only (get-balance (account principal))
  (ok (ft-get-balance hedao-token account))
)

(define-read-only (get-total-supply)
  (ok (ft-get-supply hedao-token))
)

(define-read-only (get-token-uri)
  (ok (some "https://hedao.xyz/metadata.json"))
)

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (not (is-eq sender recipient)) (err ERR-ZERO-ADDRESS))
    (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
    (try! (ft-transfer? hedao-token amount sender recipient))
    (match memo data (print {event: "transfer-memo", data: data}) (ok true))
    (ok true)
  )
)

(define-public (mint (amount uint) (recipient principal))
  (let ((current-supply (ft-get-supply hedao-token)))
    (asserts! (or (is-eq tx-sender CONTRACT-OWNER) (default-to false (map-get? minters tx-sender))) (err ERR-NOT-AUTHORIZED))
    (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
    (asserts! (<= (+ current-supply amount) (var-get mint-cap)) (err ERR-MINT-LIMIT-EXCEEDED))
    (ft-mint? hedao-token amount recipient)
  )
)

(define-public (set-minter (minter principal) (enabled bool))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) (err ERR-NOT-AUTHORIZED))
    (map-set minters minter enabled)
    (ok true)
  )
)

(define-public (burn (amount uint))
  (begin
    (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
    (ft-burn? hedao-token amount tx-sender)
  )
)

(define-private (update-accumulated-reward)
  (let (
    (current-block block-height)
    (last-block (var-get last-global-reward-block))
    (blocks-since-last (+ (- current-block last-block) u1))
  )
    (if (> blocks-since-last u0)
      (let (
        (total-staked (get-total-staked))
        (reward (if (> total-staked u0)
                  (* blocks-since-last (var-get reward-per-block))
                  u0))
      )
        (var-set accumulated-reward-per-share
          (+ (var-get accumulated-reward-per-share)
             (if (> total-staked u0) (/ (* reward u1000000000000) total-staked) u0)))
        (var-set last-global-reward-block current-block)
      )
      (ok true)
    )
  )
)

(define-read-only (get-total-staked)
  (fold + (map get-stake-amount (list)) u0)
)

(define-private (get-stake-amount (user principal))
  (default-to u0 (get amount (map-get? stakes user)))
)

(define-public (stake (amount uint) (lock-period uint))
  (let ((current-stake (map-get? stakes tx-sender)))
    (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
    (asserts! (>= lock-period u144) (err ERR-INVALID-AMOUNT)) ;; min 1 day (~144 blocks)
    (try! (update-accumulated-reward))
    (match current-stake
      stake
        (let ((new-amount (+ (get amount stake) amount)))
          (map-set stakes tx-sender
            {
              amount: new-amount,
              reward-debt: (/ (* new-amount (var-get accumulated-reward-per-share)) u1000000000000),
              last-claim-block: block-height,
              lock-until: (+ block-height lock-period)
            }
          )
          (try! (ft-transfer? hedao-token amount tx-sender (as-contract tx-sender)))
          (ok true)
        )
      (begin
        (map-set stakes tx-sender
          {
            amount: amount,
            reward-debt: (/ (* amount (var-get accumulated-reward-per-share)) u1000000000000),
            last-claim-block: block-height,
            lock-until: (+ block-height lock-period)
          }
        )
        (try! (ft-transfer? hedao-token amount tx-sender (as-contract tx-sender)))
        (ok true)
      )
    )
  )
)

(define-public (unstake (amount uint))
  (let (
    (stake (unwrap! (map-get? stakes tx-sender) (err ERR-NOT-STAKED)))
    (current-block block-height)
  )
    (asserts! (>= current-block (get lock-until stake)) (err ERR-STAKE-LOCKED))
    (asserts! (>= (get amount stake) amount) (err ERR-INSUFFICIENT-BALANCE))
    (try! (update-accumulated-reward))
    (let (
      (pending (calculate-pending-reward tx-sender))
      (new-amount (- (get amount stake) amount))
      (new-debt (if (> new-amount u0)
                  (/ (* new-amount (var-get accumulated-reward-per-share)) u1000000000000)
                  u0))
    )
      (try! (claim-reward))
      (map-set stakes tx-sender
        {
          amount: new-amount,
          reward-debt: new-debt,
          last-claim-block: current-block,
          lock-until: (if (> new-amount u0) (get lock-until stake) u0)
        }
      )
      (as-contract (ft-transfer? hedao-token amount tx-sender tx-sender))
    )
  )
)

(define-public (claim-reward)
  (let ((pending (calculate-pending-reward tx-sender)))
    (if (> pending u0)
      (let ((stake (unwrap! (map-get? stakes tx-sender) (err ERR-NOT-STAKED))))
        (map-set stakes tx-sender
          (merge stake {
            reward-debt: (/ (* (get amount stake) (var-get accumulated-reward-per-share)) u1000000000000),
            last-claim-block: block-height
          })
        )
        (try! (as-contract (ft-transfer? hedao-token pending tx-sender)))
        (ok pending)
      )
      (ok u0)
    )
  )
)

(define-read-only (calculate-pending-reward (user principal))
  (match (map-get? stakes user)
    stake
      (let (
        (updated-acc (var-get accumulated-reward-per-share))
        (user-acc (/ (* (get amount stake) updated-acc) u1000000000000))
        (owed (- user-acc (get reward-debt stake)))
      )
        owed
      )
    u0
  )
)

(define-read-only (get-stake-info (user principal))
  (map-get? stakes user)
)

(define-public (emergency-withdraw)
  (let ((stake (unwrap! (map-get? stakes tx-sender) (err ERR-NOT-STAKED))))
    (map-delete stakes tx-sender)
    (as-contract (try! (ft-transfer? hedao-token (get amount stake) tx-sender tx-sender)))
    (ok true)
  )
)

(define-public (set-reward-per-block (new-reward uint))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) (err ERR-NOT-AUTHORIZED))
    (try! (update-accumulated-reward))
    (var-set reward-per-block new-reward)
    (ok true)
  )
)

(define-public (update-reward-manually)
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) (err ERR-NOT-AUTHORIZED))
    (try! (update-accumulated-reward))
    (ok true)
  )
)

(define-read-only (get-accumulated-reward-per-share)
  (ok (var-get accumulated-reward-per-share))
)

(define-read-only (get-reward-per-block)
  (ok (var-get reward-per-block))
)

(define-read-only (get-last-global-reward-block)
  (ok (var-get last-global-reward-block))
)

(begin
  (try! (ft-mint? hedao-token u50000000000000 CONTRACT-OWNER))
  (var-set last-global-reward-block block-height)
)