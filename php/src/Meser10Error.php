<?php
namespace Meser10\Otp;

class Meser10Error extends \RuntimeException
{
    /** @var string */
    public $errorCode;

    public function __construct(string $errorCode, string $message)
    {
        parent::__construct($message);
        $this->errorCode = $errorCode;
    }
}
